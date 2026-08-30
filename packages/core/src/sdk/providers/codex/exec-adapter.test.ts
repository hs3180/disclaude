/**
 * Tests for the codex exec --json ThreadEvent adapter — Issue #4630 (S2).
 *
 * The mapping contract is locked against the wire shapes captured live from
 * codex-cli 0.132.0 (see exec-adapter.ts header). Focus:
 * - user-visible mappings: agent_message → text, command/mcp item lifecycle
 *   → tool_use/tool_result, file_change / web_search → tool_result
 * - turn lifecycle: turn.completed → result (with token metadata),
 *   turn.failed / top-level error → error
 * - tolerance: unknown event/item types, reasoning, todo_list, item.updated
 *   → null (never throw) — schema drift must not break the bridge
 * - transient reconnect notices → status (not error)
 */

import { describe, expect, it } from 'vitest';

import { adaptCodexEvent, userInputText } from './exec-adapter.js';

describe('adaptCodexEvent (Issue #4630)', () => {
  // ── captured wire shapes (0.132.0) ────────────────────────────────────

  it('maps agent_message item.completed → text with messageId', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hello' },
    });
    expect(msg).toMatchObject({
      type: 'text',
      content: 'hello',
      role: 'assistant',
      metadata: { messageId: 'item_0' },
    });
  });

  it('maps command_execution lifecycle → tool_use then tool_result', () => {
    const started = adaptCodexEvent({
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'bash -lc ls',
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    });
    expect(started).toMatchObject({
      type: 'tool_use',
      content: 'bash -lc ls',
      metadata: { toolName: 'shell', messageId: 'item_1' },
    });

    const completed = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: 'bash -lc ls',
        aggregated_output: 'docs\nsrc\n',
        exit_code: 0,
        status: 'completed',
      },
    });
    expect(completed).toMatchObject({
      type: 'tool_result',
      // Output is trimmed — whitespace-only tool results stay meaningful.
      content: 'docs\nsrc',
      metadata: { toolName: 'shell' },
    });
  });

  it('prefixes failed command_execution results with the exit code', () => {
    const failed = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'command_execution',
        command: 'bash -lc false',
        aggregated_output: '',
        exit_code: 1,
        status: 'failed',
      },
    });
    expect(failed?.type).toBe('tool_result');
    expect(failed?.content).toMatch(/^exit 1/);
  });

  it('maps mcp_tool_call lifecycle → tool_use (server.tool) / tool_result', () => {
    const started = adaptCodexEvent({
      type: 'item.started',
      item: {
        id: 'item_5',
        type: 'mcp_tool_call',
        server: 'docs',
        tool: 'search',
        arguments: { q: 'schema' },
        status: 'in_progress',
      },
    });
    expect(started).toMatchObject({
      type: 'tool_use',
      metadata: { toolName: 'docs.search', toolInput: { q: 'schema' } },
    });

    const failed = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_6',
        type: 'mcp_tool_call',
        server: 'docs',
        tool: 'search',
        arguments: {},
        error: { message: 'tool timeout' },
        status: 'failed',
      },
    });
    expect(failed).toMatchObject({
      type: 'tool_result',
      content: 'Error: tool timeout',
    });
  });

  it('maps file_change item.completed → tool_result listing changes', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_4',
        type: 'file_change',
        changes: [
          { path: 'docs/a.md', kind: 'add' },
          { path: 'docs/b.md', kind: 'update' },
        ],
        status: 'completed',
      },
    });
    expect(msg).toMatchObject({
      type: 'tool_result',
      content: 'add: docs/a.md\nupdate: docs/b.md',
      metadata: { toolName: 'file_change' },
    });
  });

  it('maps web_search item.completed → tool_result with the query', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: { id: 'item_7', type: 'web_search', query: 'codex json' },
    });
    expect(msg).toMatchObject({
      type: 'tool_result',
      content: 'codex json',
      metadata: { toolName: 'web_search' },
    });
  });

  it('maps non-fatal error ITEM → status', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: { id: 'item_9', type: 'error', message: 'command output truncated' },
    });
    expect(msg?.type).toBe('status');
  });

  // ── turn lifecycle ─────────────────────────────────────────────────────

  it('maps turn.completed → result carrying token usage', () => {
    const msg = adaptCodexEvent({
      type: 'turn.completed',
      usage: { input_tokens: 18768, cached_input_tokens: 3712, output_tokens: 5 },
    });
    expect(msg).toMatchObject({
      type: 'result',
      metadata: { inputTokens: 18768, outputTokens: 5 },
    });
  });

  it('maps turn.failed → error with the CLI message', () => {
    const msg = adaptCodexEvent({
      type: 'turn.failed',
      error: { message: 'model response stream ended unexpectedly' },
    });
    expect(msg).toMatchObject({
      type: 'error',
      content: 'model response stream ended unexpectedly',
    });
  });

  it('maps top-level error → error, but transient reconnect → status', () => {
    expect(adaptCodexEvent({ type: 'error', message: 'stream error: broken pipe' })?.type)
      .toBe('error');
    expect(adaptCodexEvent({ type: 'error', message: 'Reconnecting... 1/5' })?.type)
      .toBe('status');
  });

  // ── tolerance (schema drift must not break the bridge) ────────────────

  it('returns null for lifecycle/no-payload events', () => {
    expect(adaptCodexEvent({ type: 'thread.started', thread_id: 't1' })).toBeNull();
    expect(adaptCodexEvent({ type: 'turn.started' })).toBeNull();
    expect(
      adaptCodexEvent({ type: 'item.completed', item: { id: 'r', type: 'reasoning', text: '…' } }),
    ).toBeNull();
    expect(
      adaptCodexEvent({
        type: 'item.updated',
        item: { id: 'td', type: 'todo_list', items: [{ text: 'x', completed: true }] },
      }),
    ).toBeNull();
  });

  it('returns null for unknown top-level and item types (forward compat)', () => {
     
    expect(adaptCodexEvent({ type: 'some_future_event', extra: 1 } as any)).toBeNull();
    expect(
       
      adaptCodexEvent({ type: 'item.completed', item: { id: 'x', type: 'future_item' } } as any),
    ).toBeNull();
  });
});

describe('userInputText (Issue #4630)', () => {
  it('passes string content through', () => {
    expect(userInputText({ content: 'hello' })).toBe('hello');
  });

  it('JSON-stringifies non-string content (mirrors base-agent convertInput)', () => {
    expect(userInputText({ content: [{ type: 'text', text: 'a' }] })).toBe(
      JSON.stringify([{ type: 'text', text: 'a' }]),
    );
  });
});

describe('mcp_tool_call result payload (S2 review)', () => {
  it('surfaces successful MCP results instead of an empty tool_result', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_m1',
        type: 'mcp_tool_call',
        server: 'docs',
        tool: 'search',
        arguments: { q: 'x' },
        result: { content: [{ type: 'text', text: 'found 3 hits' }] },
        status: 'completed',
      },
    });
    expect(msg).toMatchObject({
      type: 'tool_result',
      content: 'found 3 hits',
      metadata: { toolName: 'docs.search' },
    });
  });

  it('still maps error results with the Error prefix', () => {
    const msg = adaptCodexEvent({
      type: 'item.completed',
      item: {
        id: 'item_m2',
        type: 'mcp_tool_call',
        server: 'docs',
        tool: 'search',
        error: { message: 'timeout' },
      },
    });
    expect(msg).toMatchObject({ type: 'tool_result', content: 'Error: timeout' });
  });
});

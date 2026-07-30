/**
 * Tests for the pi AgentEvent → AgentMessage adapter (Issue #4386 S3, part 1).
 *
 * Uses synthetic pi events matching the structural mirror in event-adapter.ts
 * (itself based on the #4384 spike findings against pi-agent-core@0.82.1). No
 * real pi runtime is required — the adapter is a pure function.
 */
import { describe, it, expect } from 'vitest';
import { adaptPiEvent, type PiAgentEvent } from './event-adapter.js';

describe('adaptPiEvent (Issue #4386 / #4384)', () => {
  it('maps message_update.text_delta → text', () => {
    const msg = adaptPiEvent({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    });
    expect(msg).toEqual({
      type: 'text',
      content: 'Hello',
      role: 'assistant',
      metadata: {},
    });
  });

  it('returns null for non-text_delta assistant events (MVP skips thinking/frame)', () => {
    const skipped: PiAgentEvent[] = [
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'reasoning...' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_start' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end' },
      },
      // pi-ai's real tool-call sub-events (toolcall_*, NOT Anthropic's tool_use_*):
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_delta' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_end' },
      },
      // pi-ai terminates the sub-stream with done/error (NOT message_end):
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'done' },
      },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'error' },
      },
    ];
    for (const ev of skipped) {
      expect(adaptPiEvent(ev)).toBeNull();
    }
  });

  it('maps tool_execution_start → tool_use with args + toolCallId', () => {
    const msg = adaptPiEvent({
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'search',
      args: { q: 'pi.dev' },
    });
    expect(msg?.type).toBe('tool_use');
    expect(msg?.content).toBe('search');
    expect(msg?.metadata).toMatchObject({
      toolName: 'search',
      toolInput: { q: 'pi.dev' },
      messageId: 'call_1',
    });
  });

  it('maps tool_execution_update → tool_progress with partialResult', () => {
    const msg = adaptPiEvent({
      type: 'tool_execution_update',
      toolCallId: 'call_1',
      toolName: 'search',
      partialResult: { hits: 3 },
    });
    expect(msg?.type).toBe('tool_progress');
    expect(msg?.metadata).toMatchObject({
      toolName: 'search',
      toolOutput: { hits: 3 },
      messageId: 'call_1',
    });
  });

  it('maps tool_execution_end (success) → tool_result with stringified content', () => {
    const msg = adaptPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'search',
      result: { hits: 3 },
      isError: false,
    });
    expect(msg?.type).toBe('tool_result');
    expect(msg?.content).toBe(JSON.stringify({ hits: 3 }));
    expect(msg?.metadata).toMatchObject({
      toolName: 'search',
      toolOutput: { hits: 3 },
      messageId: 'call_1',
    });
  });

  it('maps tool_execution_end (error) → tool_result with "Error: " prefix', () => {
    const msg = adaptPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_2',
      toolName: 'bash',
      result: 'command not found',
      isError: true,
    });
    expect(msg?.type).toBe('tool_result');
    expect(msg?.content).toBe('Error: command not found');
  });

  it('keeps string results as-is (no JSON-quoting)', () => {
    const msg = adaptPiEvent({
      type: 'tool_execution_end',
      toolCallId: 'c',
      toolName: 't',
      result: 'plain string',
      isError: false,
    });
    expect(msg?.content).toBe('plain string');
  });

  it('maps agent_end → result', () => {
    const msg = adaptPiEvent({ type: 'agent_end', messages: [] });
    expect(msg?.type).toBe('result');
    expect(msg?.role).toBe('assistant');
  });

  it('returns null for lifecycle events (agent_start, turn_*, message_start/end)', () => {
    const lifecycle: PiAgentEvent[] = [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'turn_end' },
      { type: 'message_start' },
      { type: 'message_end' },
    ];
    for (const ev of lifecycle) {
      expect(adaptPiEvent(ev)).toBeNull();
    }
  });
});

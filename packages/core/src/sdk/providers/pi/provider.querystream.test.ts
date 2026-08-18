/**
 * Tests for PiAgentProvider.queryStream — Issue #4386 (S3, part 3).
 *
 * queryStream drives pi-agent-core's `Agent` class via the lazy runtime
 * loader (pi-runtime.ts). These tests mock the '@earendil-works/pi-agent-core'
 * module with a fake `Agent` that reproduces the REAL semantics the bridge
 * depends on (verified against the published 0.82.1 tarball, dist/agent.d.ts):
 *
 * - `subscribe(listener)` → returns unsubscribe; listeners are invoked
 *   per AgentEvent (awaited, in subscription order).
 * - `prompt(message)` → Promise that resolves when the run settles, AFTER
 *   the events have been emitted.
 * - `followUp(message)` → queues a follow-up turn.
 * - `abort()` → cancels the active run.
 *
 * The fake emits a scripted event sequence on prompt() so we can assert the
 * full bridge behavior: event → AgentMessage mapping (via the event-adapter),
 * stream ordering, multi-turn input pumping, abort via handle.cancel(), the
 * no-agent_end hang guard, and the no-streamFn / disposed guards.
 *
 * The disclaude-side event mapping itself is covered exhaustively in
 * event-adapter.test.ts; here we assert the mapped TYPE of the first-class
 * cases (text delta → text, tool_execution_start → tool_use, agent_end →
 * result) — i.e., that queryStream wires the adapter in unmodified.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// --- Fake pi-agent-core module ------------------------------------------------
// vi.mock is hoisted; the state it closes over must be hoisted too.

type FakeEvent = Record<string, unknown> & { type: string };

const { fakeState } = vi.hoisted(() => {
  return {
    fakeState: {
      /** Arguments of each prompt()/followUp() call, in order. */
      prompts: [] as unknown[],
      /** True after abort() was called. */
      aborted: false,
      /** Event batches to emit per prompt() call (shifted; [] = run settles silently). */
      scripts: [] as FakeEvent[][],
      /** AgentOptions captured from the constructor. */
      ctorOptions: null as unknown,
      /** Live listeners registered via subscribe(). */
      listeners: [] as Array<(event: FakeEvent) => Promise<void> | void>,
    },
  };
});

class FakeAgent {
  private followUpQueue: unknown[] = [];
  constructor(options: unknown) {
    fakeState.ctorOptions = options;
  }
  subscribe(listener: (event: FakeEvent) => Promise<void> | void): () => void {
    fakeState.listeners.push(listener);
    return () => {
      fakeState.listeners = fakeState.listeners.filter((l) => l !== listener);
    };
  }
  async prompt(message: unknown): Promise<void> {
    fakeState.prompts.push(message);
    const events = fakeState.scripts.shift() ?? [{ type: 'agent_end', messages: [] }];
    for (const event of events) {
      for (const listener of [...fakeState.listeners]) {
        await listener(event);
      }
    }
  }
  followUp(message: unknown): Promise<void> {
    fakeState.prompts.push(message);
    // Real pi semantics (0.82.1 agent.js:175): followUp only ENQUEUES — it
    // does not start a run. The queue is drained at a run's stop checkpoint
    // (agent-loop.js:163), or by continue() on an idle agent.
    this.followUpQueue.push(message);
    return Promise.resolve();
  }
  /** Real pi semantics: drains the queued follow-ups into a new run. */
  async continue(): Promise<void> {
    if (this.followUpQueue.length === 0) {
      // Real Agent.continue() throws when there is nothing to continue from.
      throw new Error('Cannot continue from message role: assistant');
    }
    const batch = this.followUpQueue.splice(0);
    const events = fakeState.scripts.shift() ?? [{ type: 'agent_end', messages: [] }];
    for (const event of events) {
      for (const listener of [...fakeState.listeners]) {
        await listener(event);
      }
    }
    void batch;
  }
  abort(): void {
    fakeState.aborted = true;
  }
  async waitForIdle(): Promise<void> {}
}

vi.mock('@earendil-works/pi-agent-core', () => ({ Agent: FakeAgent }));

import { PiAgentProvider } from './provider.js';
import { resetPiRuntimeCache } from './pi-runtime.js';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';

// Helper: an async generator yielding the given inputs (the provider contract).
async function* inputs(...values: UserInput[]): AsyncGenerator<UserInput> {
  for (const value of values) {
    yield value;
  }
}

function userInput(text: string): UserInput {
  return { role: 'user', content: text };
}

/** Collect all AgentMessages from the iterator. */
async function collect(iterator: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const message of iterator) {
    out.push(message);
  }
  return out;
}

/** A streamFn stub — queryStream only requires it to be set (see PR scope). */
const stubStreamFn = (): unknown => ({});

/** Minimal valid AgentQueryOptions (settingSources is required by the type). */
const baseOptions = (): AgentQueryOptions & { systemPrompt?: string } =>
  ({ settingSources: [] }) as AgentQueryOptions & { systemPrompt?: string };

describe('PiAgentProvider.queryStream (Issue #4386, part 3)', () => {
  let provider: PiAgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    resetPiRuntimeCache();
    fakeState.prompts = [];
    fakeState.aborted = false;
    fakeState.scripts = [];
    fakeState.ctorOptions = null;
    fakeState.listeners = [];
    provider = new PiAgentProvider();
    provider.streamFn = stubStreamFn;
  });

  it('throws a clear error when no stream function is configured', () => {
    provider.streamFn = null;
    expect(() => provider.queryStream(inputs(userInput('hi')), baseOptions())).toThrow(
      /no stream function configured/,
    );
  });

  it('throws when the provider has been disposed', () => {
    provider.dispose();
    expect(() => provider.queryStream(inputs(userInput('hi')), baseOptions())).toThrow(/disposed/);
  });

  it('passes the injected streamFn and adapted system prompt to the pi Agent', async () => {
    fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
    const messages = await collect(
      provider.queryStream(inputs(userInput('hi')), { ...baseOptions(), systemPrompt: 'be terse' }).iterator,
    );
    expect(fakeState.ctorOptions).toMatchObject({
      streamFn: stubStreamFn,
      initialState: { systemPrompt: 'be terse' },
    });
    // agent_end maps to the result message (see event-adapter).
    expect(messages.map((m) => m.type)).toContain('result');
  });

  // -------------------------------------------------------------------------
  // Issue #4389 (S6, part 1): tool permission gate on the beforeToolCall hook
  // -------------------------------------------------------------------------

  it('installs the beforeToolCall deny hook when disallowedTools is non-empty (#4389)', async () => {
    fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
    await collect(
      provider
        .queryStream(inputs(userInput('hi')), {
          ...baseOptions(),
          disallowedTools: ['CronCreate'],
        })
        .iterator,
    );
    const ctorOptions = fakeState.ctorOptions as { beforeToolCall?: unknown };
    expect(typeof ctorOptions.beforeToolCall).toBe('function');
    // And the installed hook actually denies the disallowed tool (#4389
    // acceptance: a disallowed call does not execute — `{block:true}` is
    // what pi's loop converts into an error tool result pre-execution).
    const verdict = (await (ctorOptions.beforeToolCall as (ctx: unknown) => Promise<unknown>)({
      assistantMessage: { role: 'assistant', content: [] },
      toolCall: { type: 'toolCall', id: 't1', name: 'CronCreate', arguments: {} },
      args: {},
      context: {},
    })) as { block?: boolean; reason?: string } | undefined;
    expect(verdict).toEqual({ block: true, reason: expect.stringContaining('CronCreate') });
  });

  it('omits the beforeToolCall hook when disallowedTools is absent (#4389 — behavior unchanged)', async () => {
    fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
    await collect(provider.queryStream(inputs(userInput('hi')), baseOptions()).iterator);
    const ctorOptions = fakeState.ctorOptions as { beforeToolCall?: unknown };
    expect(ctorOptions.beforeToolCall).toBeUndefined();
  });

  // Issue #4386 (part 4): inline tools from options.mcpServers are injected
  // into the pi Agent's initialState.tools — the session's live tool registry
  // (pi 0.82.1: createMutableAgentState seeds state.tools from it at
  // construction). This is the "tool passed directly, not via MCP" acceptance
  // item; stdio servers are skipped (pi does not support MCP, #4461 decision).
  describe('inline-tool injection (Issue #4386, part 4)', () => {
    /** A real-Zod inline tool (the adapter's zodToJsonSchema needs a real schema). */
    const makeTool = (name: string) => ({
      name,
      description: `${name} tool`,
      parameters: z.object({ x: z.number() }),
      handler: (p: { x: number }) => Promise.resolve({ doubled: p.x * 2 }),
    });

    it('seeds initialState.tools with adapted inline tools from mcpServers', async () => {
      fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
      await collect(
        provider.queryStream(inputs(userInput('hi')), {
          ...baseOptions(),
          mcpServers: {
            'channel-mcp': { type: 'inline', name: 'channel-mcp', version: '1.0.0', tools: [makeTool('echo')] },
          },
        }).iterator,
      );
      const ctor = fakeState.ctorOptions as { initialState?: { tools?: unknown[] } };
      const tools = ctor?.initialState?.tools ?? [];
      expect(tools).toHaveLength(1);
      // The AgentHarnessTool shape produced by adaptInlineTool (#4387).
      const tool = tools[0] as { name: string; label: string; parameters: { type: string } };
      expect(tool.name).toBe('echo');
      expect(tool.label).toBe('echo');
      expect(tool.parameters.type).toBe('object');
      expect(typeof (tools[0] as { execute: unknown }).execute).toBe('function');
    });

    it('injects an empty tool array when no inline servers are configured', async () => {
      fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
      await collect(provider.queryStream(inputs(userInput('hi')), baseOptions()).iterator);
      const ctor = fakeState.ctorOptions as { initialState?: { tools?: unknown[] } };
      expect(ctor?.initialState?.tools).toEqual([]);
    });

    it('skips stdio servers (pi does not support MCP) but still injects inline ones', async () => {
      fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
      await collect(
        provider.queryStream(inputs(userInput('hi')), {
          ...baseOptions(),
          mcpServers: {
            playwright: { type: 'stdio', name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] },
            'channel-mcp': { type: 'inline', name: 'channel-mcp', version: '1.0.0', tools: [makeTool('send')] },
          },
        }).iterator,
      );
      const ctor = fakeState.ctorOptions as { initialState?: { tools?: Array<{ name: string }> } };
      expect((ctor?.initialState?.tools ?? []).map((t) => t.name)).toEqual(['send']);
    });

    it('injected tools execute through the inline-tool adapter round-trip', async () => {
      // The full acceptance item: the tool handed to the Agent is the SAME
      // wrapper createInlineTool produces — its execute validates params via
      // Zod, calls the disclaude handler, and shapes an AgentToolResult.
      fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
      await collect(
        provider.queryStream(inputs(userInput('go')), {
          ...baseOptions(),
          mcpServers: {
            'channel-mcp': { type: 'inline', name: 'channel-mcp', version: '1.0.0', tools: [makeTool('echo')] },
          },
        }).iterator,
      );
      const ctor = fakeState.ctorOptions as { initialState?: { tools?: Array<{ execute: Function }> } };
      const tool = ctor?.initialState?.tools?.[0];
      expect(tool).toBeDefined();
      const result = (await tool!.execute('call-1', { x: 21 }, undefined, undefined, undefined)) as {
        content: Array<{ type: string; text: string }>;
        details: unknown;
      };
      expect(result.details).toEqual({ doubled: 42 });
      expect(result.content[0]?.type).toBe('text');
      // Invalid params throw (pi converts a thrown execute error into an
      // isError tool result — the adapter contract, #4387).
      await expect(tool!.execute('call-2', { x: 'not-a-number' }, undefined, undefined, undefined)).rejects.toThrow();
    });

    it('recognizes the createMcpServer handle shape (the production wiring) without re-adapting', async () => {
      // The production path: chat-agent's buildMcpServers() puts
      // createChannelMcpServer() = getProvider().createMcpServer({...type:'inline'...})
      // into mcpServers — a `{ name, version, tools }` handle with NO `type`
      // field whose tools are ALREADY AgentHarnessTools. collectInlineTools
      // must pass those through as-is (re-adapting would double-wrap execute
      // and Zod-parse a JSON-Schema object). Cf. ClaudeSDKProvider's
      // isSdkInlineMcpServer duck-typing for the same production flow.
      fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
      const handle = provider.createMcpServer({
        type: 'inline',
        name: 'channel-mcp',
        version: '1.0.0',
        tools: [makeTool('send_text')],
      });
      await collect(
        provider.queryStream(inputs(userInput('hi')), {
          ...baseOptions(),
          // base-agent.ts:202 casts the built handle record into the options
          // the same way — the handle shape is not statically a McpServerConfig.
          mcpServers: { 'channel-mcp': handle } as unknown as AgentQueryOptions['mcpServers'],
        }).iterator,
      );
      const ctor = fakeState.ctorOptions as { initialState?: { tools?: Array<{ name: string; execute: Function }> } };
      const tools = ctor?.initialState?.tools ?? [];
      expect(tools.map((t) => t.name)).toEqual(['send_text']);
      // The SAME adapted instance, not a re-wrapped one: executing it runs the
      // original handler round-trip.
      const result = (await tools[0]!.execute('call-h', { x: 5 }, undefined, undefined, undefined)) as {
        details: unknown;
      };
      expect(result.details).toEqual({ doubled: 10 });
    });
  });

  it('streams a plain-text turn: text deltas then result', async () => {
    fakeState.scripts = [
      [
        { type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } },
        { type: 'agent_end', messages: [] },
      ],
    ];
    const messages = await collect(
      provider.queryStream(inputs(userInput('hi')), baseOptions()).iterator,
    );
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    expect(texts).toEqual(['Hello', ' world']);
    expect(messages[messages.length - 1]?.type).toBe('result');
  });

  it('streams tool execution events (start → tool_use, end → tool_result)', async () => {
    fakeState.scripts = [
      [
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'echo', args: { x: 1 } },
        {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'echo',
          result: 'ok',
          isError: false,
        },
        { type: 'agent_end', messages: [] },
      ],
    ];
    const messages = await collect(provider.queryStream(inputs(userInput('go')), baseOptions()).iterator);
    const types = messages.map((m) => m.type);
    expect(types).toEqual(['tool_use', 'tool_result', 'result']);
  });

  it('seeds the first input via prompt() and later inputs via followUp()', async () => {
    fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
    const gen = inputs(userInput('first'), userInput('second'), userInput('third'));
    await collect(provider.queryStream(gen, baseOptions()).iterator);
    expect(fakeState.prompts).toHaveLength(3);
    expect((fakeState.prompts[0] as { content: string }).content).toBe('first');
    expect((fakeState.prompts[1] as { content: string }).content).toBe('second');
    expect((fakeState.prompts[2] as { content: string }).content).toBe('third');
  });

  it('ends the stream cleanly when the input generator is already exhausted', async () => {
    async function* empty(): AsyncGenerator<UserInput> {}
    const messages = await collect(provider.queryStream(empty(), baseOptions()).iterator);
    expect(messages).toEqual([]);
    expect(fakeState.prompts).toEqual([]);
  });

  it('ends the stream when the input generator is exhausted after a silent run (hang guard)', async () => {
    // Scripted run that resolves prompt() WITHOUT any events (e.g. a crashed
    // or aborted loop). The naive bridge would wait for agent_end forever;
    // queryStream's run-settlement guard must wake the consumer and end the
    // stream once the input is also exhausted.
    fakeState.scripts = [[]];
    const messages = await collect(provider.queryStream(inputs(userInput('hi')), baseOptions()).iterator);
    expect(messages).toEqual([]);
  });

  it('does not hang when the input generator stays open after the run settles (Bug A)', async () => {
    // Regression (review round 1/2, Bug A): the bridge used to abort() the
    // agent in the consumer loop's finally-equivalent path as soon as a run
    // settled. The production input is chat-agent's MessageChannel generator
    // (message-channel.ts), which stays open for the WHOLE session — the
    // abort made the bridge's own input pump park forever inside
    // inputIterator.next() (the generator never ends), and the consumer's
    // teardown await on that pump hung the next user turn. The bridge must
    // instead park with the input still open, waiting for a possible next
    // turn, and only end when the input generator ends.
    fakeState.scripts = [[{ type: 'agent_end', messages: [] }]];
    let releaseInput: (() => void) | undefined;
    const scriptedInput = (async function* (): AsyncGenerator<UserInput> {
      yield userInput('first');
      // Park like MessageChannel.generator(): never yield again until the
      // channel closes (here: until the test releases the generator).
      await new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
    })();
    const result = provider.queryStream(scriptedInput, baseOptions());
    const consuming = collect(result.iterator);
    // Give the bridge time to (wrongly) end early / hang: a couple of macrotasks
    // past run settlement. The iterator must still be open (no early return).
    await new Promise((resolve) => setTimeout(resolve, 20));
    // ... and must NOT have aborted the agent between turns.
    expect(fakeState.aborted).toBe(false);
    // End the input (the session-lifetime signal) → the bridge must settle
    // promptly; this is the await that used to hang forever.
    releaseInput?.();
    const messages = await consuming;
    expect(messages.map((m) => m.type)).toContain('result');
  });

  it('keeps the session alive between turns: a second input after the first run settles runs as a follow-up', async () => {
    // The ClaudeSDKProvider contract this bridge must match: one long-lived
    // query per chat. Turn 2 arrives on chat-agent's still-open
    // MessageChannel AFTER run 1 settled — the bridge must not have torn
    // anything down between turns (no abort), and the queued follow-up must
    // actually run (followUp() only enqueues; an idle agent needs
    // continue() to drain the queue into a new run — real pi-agent-core
    // 0.82.1 semantics: agent-loop.js drains the follow-up queue only at a
    // run's stop checkpoint).
    fakeState.scripts = [
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'one' } }, { type: 'agent_end', messages: [] }],
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'two' } }, { type: 'agent_end', messages: [] }],
    ];
    let releaseSecond: (() => void) | undefined;
    const scriptedInput = (async function* (): AsyncGenerator<UserInput> {
      yield userInput('first');
      await new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      yield userInput('second');
    })();
    const result = provider.queryStream(scriptedInput, baseOptions());
    const consuming = collect(result.iterator);
    await new Promise((resolve) => setTimeout(resolve, 10)); // run 1 settles
    expect(fakeState.aborted).toBe(false); // session kept alive
    releaseSecond?.(); // user sends turn 2
    const messages = await consuming;
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    expect(texts).toEqual(['one', 'two']); // turn 2 actually ran
    expect(fakeState.prompts).toHaveLength(2); // prompt() then followUp()+continue()
  });

  it('handle.cancel() aborts the pi agent and the consumer does not hang', async () => {
    fakeState.scripts = [
      [
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
        },
        // No agent_end: simulate a hung run. cancel() must abort the agent,
        // and the iterator must still terminate for the consumer.
      ],
    ];
    const result = provider.queryStream(inputs(userInput('hi')), baseOptions());
    const consuming = collect(result.iterator);
    // Give the bridge a tick to start the run (prompt in flight), then cancel.
    await new Promise((resolve) => setTimeout(resolve, 0));
    result.handle.cancel();
    // Deterministic on both sides of the loadPiRuntime race: when the agent
    // already exists abort() is synchronous; when cancel() landed during the
    // lazy import the latch aborts at construction (a microtask later).
    await vi.waitFor(() => {
      expect(fakeState.aborted).toBe(true);
    });
    await consuming; // must resolve, not hang
  });

  it('consumer breaking out of the for-await mid-stream settles without hanging (Bug A)', async () => {
    // Regression (review rounds 1/2, Bug A — the exact production shape):
    // chat-agent.ts:987 breaks out of its for-await on /stop (abort signal),
    // while the MessageChannel input generator stays OPEN for the session.
    // The consumer's break awaits this generator's return(); the old teardown
    // awaited the input pump, which parks forever inside
    // inputIterator.next() when the generator never ends — so the break (and
    // with it the whole turn) hung. Teardown must not wait on the pump, and
    // the agent must be aborted so the in-flight run ends.
    fakeState.scripts = [
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }],
      // No agent_end: the run is still in flight when the consumer breaks.
    ];
    const scriptedInput = (async function* (): AsyncGenerator<UserInput> {
      yield userInput('hi');
      await new Promise<void>(() => {}); // channel never closes
    })();
    const result = provider.queryStream(scriptedInput, baseOptions());
    let iterations = 0;
    try {
      for await (const _message of result.iterator) {
        iterations++;
        break; // chat-agent's abort-signal break
      }
    } finally {
      result.handle.close(); // chat-agent's teardown equivalent
    }
    expect(iterations).toBe(1);
    await vi.waitFor(() => {
      expect(fakeState.aborted).toBe(true); // in-flight run released
    });
  });

  it('handle.cancel() before the runtime finishes loading is latched, not dropped', async () => {
    // Regression (CI flake): queryStream() returns the handle synchronously,
    // but the Agent is only constructed after `await loadPiRuntime()` inside
    // the iterator. A cancel() landing in that window used to no-op against
    // `agent === null` and be silently dropped — the run then started anyway.
    // The latch must abort the agent once it exists and never start the run.
    fakeState.scripts = [
      [{ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } }],
    ];
    const result = provider.queryStream(inputs(userInput('hi')), baseOptions());
    const consuming = collect(result.iterator);
    // Cancel immediately — synchronously after queryStream, before yielding
    // control: the iterator has not run at all yet, so agent is still null.
    result.handle.cancel();
    const messages = await consuming;
    expect(messages).toEqual([]); // nothing streamed: the run never started
    expect(fakeState.aborted).toBe(true); // the latch reached the agent
    expect(fakeState.prompts).toEqual([]); // prompt() was never called
  });
});

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
    return Promise.resolve();
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

  it('ends the stream when the run settles without emitting agent_end (hang guard)', async () => {
    // Scripted run that resolves prompt() WITHOUT any events (e.g. a crashed
    // or aborted loop). The naive bridge would wait for agent_end forever;
    // queryStream's run-settlement guard must wake the consumer and end the
    // stream.
    fakeState.scripts = [[]];
    const messages = await collect(provider.queryStream(inputs(userInput('hi')), baseOptions()).iterator);
    expect(messages).toEqual([]);
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
    expect(fakeState.aborted).toBe(true);
    await consuming; // must resolve, not hang
  });
});

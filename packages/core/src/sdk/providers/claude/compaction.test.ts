import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverCompactionWindow,
  readContextLimit,
  withDiscoveredCompaction,
} from './compaction.js';
import type { AgentQueryOptions, StreamQueryResult, UserInput } from '../../types.js';

let sequence = 0;
const fetchMock = vi.fn();
const options = (): AgentQueryOptions => ({
  model: `test-model-${sequence++}`,
  settingSources: [],
  autoCompactWindow: 'auto',
  env: { ANTHROPIC_BASE_URL: 'https://provider.invalid/v1', ANTHROPIC_API_KEY: 'test-key' },
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('model context discovery', () => {
  it('keeps native Claude compaction under SDK ownership without metadata discovery', async () => {
    expect(await discoverCompactionWindow({ ...options(), model: 'claude-native-fixture' }, new AbortController().signal)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the process auth token when no API key is configured', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-auth-token');
    const opts = options();
    delete opts.env!.ANTHROPIC_API_KEY;
    fetchMock.mockResolvedValue(response({ id: opts.model, context_length: 100000 }));
    expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBe(80000);
    expect(fetchMock.mock.calls[0][1].headers.authorization).toBe('Bearer synthetic-auth-token');
  });
  it.each(['max_input_tokens', 'context_length', 'context_window'])(
    'reads %s and reserves 20%%',
    async (field) => {
      const opts = options();
      fetchMock.mockResolvedValue(response({ id: opts.model, [field]: 128000 }));
      expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBe(102400);
      expect(String(fetchMock.mock.calls[0][0])).toBe(
        `https://provider.invalid/v1/models/${opts.model}`
      );
      expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
    }
  );

  it('falls back to list metadata and selects the exact model', async () => {
    const opts = options();
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(
      response({
        data: [
          { id: 'unrelated', context_length: 1000000 },
          { id: opts.model, context_length: 32000 },
        ],
      })
    );
    expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBe(25600);
  });

  it('does not mistake output limits or malformed values for context limits', () => {
    for (const value of [0, -1, 1.5, '128000', Infinity]) {
      expect(readContextLimit({ context_length: value })).toBeUndefined();
    }
    expect(readContextLimit({ max_tokens: 8192 })).toBeUndefined();
  });

  it('leaves the override absent when a DeepSeek-style list has no context metadata', async () => {
    const opts = options();
    opts.env!.ANTHROPIC_BASE_URL = 'https://provider.invalid/anthropic';
    fetchMock
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response({ data: [{ id: opts.model, owned_by: 'deepseek' }] }));
    expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://provider.invalid/models');
  });

  it('never selects another model when the requested one is missing', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ data: [{ id: 'other', context_length: 999999 }] }))
    );
    expect(await discoverCompactionWindow(options(), new AbortController().signal)).toBeUndefined();
  });

  it('caches metadata per endpoint/model/credential and expires it', async () => {
    vi.useFakeTimers();
    const opts = options();
    fetchMock.mockImplementation(() =>
      Promise.resolve(response({ id: opts.model, context_window: 64000 }))
    );
    expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBe(51200);
    expect(await discoverCompactionWindow(opts, new AbortController().signal)).toBe(51200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    opts.env!.ANTHROPIC_API_KEY = 'different-key';
    await discoverCompactionWindow(opts, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(300001);
    await discoverCompactionWindow(opts, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('stops on authentication rejection without guessing a threshold', async () => {
    fetchMock.mockResolvedValue(response({}, 401));
    expect(await discoverCompactionWindow(options(), new AbortController().signal)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds metadata lookup time', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const pending = discoverCompactionWindow(options(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toBeUndefined();
  });
});

describe('deferred SDK startup', () => {
  const input = async function* (): AsyncGenerator<UserInput> {
    yield { role: 'user', content: 'test' };
  };
  it('passes discovered metadata before creating the SDK query', async () => {
    const opts = options();
    fetchMock.mockResolvedValue(response({ id: opts.model, context_length: 1000000 }));
    const close = vi.fn();
    const start = vi.fn(
      (_input: AsyncGenerator<UserInput>, _options: AgentQueryOptions): StreamQueryResult => ({
        handle: { close, cancel: vi.fn() },
        iterator: (async function* () {})(),
      })
    );
    const stream = withDiscoveredCompaction(input(), opts, start);
    expect(start).not.toHaveBeenCalled();
    await stream.iterator.next();
    expect(start.mock.calls[0][1]).toMatchObject({ autoCompactWindow: 800000 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });

  it('does not launch a subprocess after cancellation during discovery', async () => {
    const opts = options();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const start = vi.fn();
    const stream = withDiscoveredCompaction(input(), opts, start);
    const pending = stream.iterator.next();
    stream.handle.cancel();
    expect((await pending).done).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});

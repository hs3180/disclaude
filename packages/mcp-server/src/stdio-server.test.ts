/**
 * Tests for the stdio transport loop (packages/mcp-server/src/stdio-server.ts).
 *
 * Issue #4128 (part 2): the transport loop was extracted out of cli.ts. These
 * tests pin its framing contract independently of request routing — stdin is
 * captured via spies, and a stub handler stands in for the real router.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// stdio-server.ts only pulls createLogger out of core; stub it so no real logger runs.
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { startStdioServer, type JsonRpcRequest, type JsonRpcResponse } from './stdio-server.js';

type Handler = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;
type Listener = (...args: unknown[]) => unknown;

const handleRequest = vi.fn<Handler>();

describe('startStdioServer', () => {
  let onSpy: ReturnType<typeof vi.spyOn>;
  let setEncodingSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  // Listeners registered via the mocked process.stdin.on(), captured per test.
  let listeners: Record<string, Listener>;

  beforeEach(() => {
    listeners = {};
    handleRequest.mockReset();

    // Intercept listener registration without touching the real stdin emitter.
    onSpy = vi.spyOn(process.stdin, 'on').mockImplementation(((event: string, listener: Listener) => {
      listeners[event] = listener;
      return process.stdin;
    }) as never);
    setEncodingSpy = vi.spyOn(process.stdin, 'setEncoding').mockImplementation((() => undefined) as never);

    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    startStdioServer(handleRequest);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Drive the captured 'data' listener and await its async work. */
  const emit = (chunk: string): Promise<void> =>
    (listeners['data'] as (chunk: string) => Promise<void>)(chunk);

  it('configures stdin for utf-8 text and registers data/end listeners', () => {
    expect(setEncodingSpy).toHaveBeenCalledWith('utf-8');
    expect(onSpy).toHaveBeenCalledWith('data', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('end', expect.any(Function));
  });

  it('frames a well-formed request: serializes the handler response to stdout', async () => {
    handleRequest.mockResolvedValue({ jsonrpc: '2.0', id: 7, result: { ok: true } });
    await emit('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    expect(handleRequest).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } }),
    );
  });

  it('buffers a partial line across chunks and only emits once the newline arrives', async () => {
    handleRequest.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
    await emit('{"jsonrpc":"2.0","id":1'); // no newline yet — nothing dispatched
    expect(handleRequest).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    await emit(',"method":"ping"}\n'); // completes the line
    expect(handleRequest).toHaveBeenCalledTimes(1);
    expect(handleRequest).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  it('dispatches multiple newline-delimited messages in one chunk, in order', async () => {
    handleRequest.mockImplementation(async (request) => ({ jsonrpc: '2.0', id: request.id, result: {} }));
    await emit('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n');
    expect(handleRequest).toHaveBeenCalledTimes(2);
    expect(handleRequest.mock.calls[0][0].method).toBe('a');
    expect(handleRequest.mock.calls[1][0].method).toBe('b');
  });

  it('skips blank lines without invoking the handler', async () => {
    await emit('\n\n\n');
    expect(handleRequest).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns a JSON-RPC parse error (-32700) for malformed JSON and does not call the handler', async () => {
    await emit('not-valid-json\n');
    expect(handleRequest).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const emitted = JSON.parse(errorSpy.mock.calls[0][0] as string);
    expect(emitted).toEqual({
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32700, message: 'Parse error' },
    });
  });

  it('exits cleanly (0) when stdin ends', () => {
    (listeners['end'] as () => void)();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

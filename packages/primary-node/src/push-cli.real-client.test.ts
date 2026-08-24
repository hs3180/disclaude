/**
 * Real-client route for push-cli — the transport against the production
 * RestIpcClient, not a mock class.
 *
 * Issue #4543 (part 2, salvaged from the closed #4558 per its final review
 * verdict): the sibling `push-cli.test.ts` covers the CLI's argv/error
 * branches with a mocked client class asserting constructor args. This file
 * complements it on the zero-conflict delta the verdict called out — run the
 * CLI's actual wiring through the REAL client and REAL pushToAgent facade,
 * stubbing only the network (globalThis.fetch), in the style of
 * `packages/core/src/ipc/rest-ipc-client.test.ts`.
 *
 * What only this route can pin:
 * - constructor trailing-slash normalization feeding the request URL,
 * - POST /api/push routing with content-type + Bearer headers from env,
 * - the REST `{ok}` envelope → IPC `{success}` shape translation,
 * - the real `disconnect()` no-op being awaited on the success path.
 *
 * @module primary-node/push-cli.real-client.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No vi.mock('@disclaude/core') here — main() pulls the real RestIpcClient
// and the real pushToAgent facade. Only fetch is stubbed, at the network
// layer, so the CLI → facade → client → HTTP chain runs production code end
// to end.
import { main } from './push-cli.js';

describe('push-cli (real RestIpcClient route, Issue #4543 part 2)', () => {
  const originalFetch = globalThis.fetch;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalArgv: string[];
  let calls: Array<{ url: string; init: RequestInit }>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    originalArgv = process.argv;
    // Issue #4543: transport env must not leak between tests — the CLI reads
    // these directly, so start every test from the documented defaults.
    delete process.env.DISCLAUDE_REST_IPC_ENABLED;
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_API_TOKEN;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.argv = originalArgv;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  /** Network-layer stub: record calls, reply with a REST `{ok}` body. */
  function stubFetch(responses: Array<{ status?: number; json: Record<string, unknown> }>): void {
    let i = 0;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      calls.push({ url: input, init: init ?? {} });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve({
        ok: r.status === undefined || r.status < 400,
        status: r.status ?? 200,
        json: () => Promise.resolve(r.json),
      } as Response);
    }) as unknown as typeof fetch;
  }

  it('pushes through the real client: POST /api/push, Bearer + content-type, {ok}→{success}', async () => {
    process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'sekret';
    stubFetch([{ json: { ok: true, message: 'pushed' } }]);
    process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];

    await main();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://localhost:9200/api/push');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer sekret',
    });
    // The facade passes waitForCompletion through to the wire payload.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      chatId: 'oc_test',
      message: 'hello',
      waitForCompletion: undefined,
    });
    // REST {ok:true} translated to the IPC {success:true} the CLI logs on.
    expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
  });

  it('normalizes a trailing slash in DISCLAUDE_REST_IPC_BASE_URL before the request URL', async () => {
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://primary.internal:9300/';
    stubFetch([{ json: { ok: true, message: 'pushed' } }]);
    process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];

    await main();

    // The env value passes through the CLI verbatim (pinned by the sibling
    // mock-class test); the REAL constructor's strip is what cleans it up —
    // no `9300//api/push` double slash on the wire.
    expect(calls[0].url).toBe('http://primary.internal:9300/api/push');
  });

  it('sends no authorization header when no token is configured', async () => {
    stubFetch([{ json: { ok: true, message: 'pushed' } }]);
    process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];

    await main();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('maps a fetch failure to ipc_unavailable with the actionable REST-only guidance', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('fetch failed'))) as typeof fetch;
    process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];

    await expect(main()).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    // The REAL facade's classifyError tags transport failures ipc_unavailable,
    // and the CLI's #4543 scope-3 guidance keys off exactly that type.
    const out = errorSpy.mock.calls.map((args: unknown[]) => String(args[0])).join('\n');
    expect(out).toContain('ipc_unavailable');
    expect(out).toContain('http://localhost:9200');
    expect(out).toContain('--api-port');
  });

  it('awaits the real disconnect() no-op after success (stateless HTTP, no throw)', async () => {
    stubFetch([{ json: { ok: true, message: 'pushed' } }]);
    process.argv = ['node', 'push-cli', '-c', 'oc_test', '-m', 'hello'];

    // Reaching here without an unhandled rejection is the assertion: the real
    // disconnect() resolves immediately and main()'s finally awaits it.
    await main();
    expect(logSpy).toHaveBeenCalledWith('Message pushed successfully.');
  });
});

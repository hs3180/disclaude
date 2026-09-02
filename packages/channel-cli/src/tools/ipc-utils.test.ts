/**
 * Tests for channel-cli/tools/ipc-utils (Issue #4280 Phase 3 part 3: REST-only).
 *
 * `isIpcAvailable` probes `GET /api/ping` on the PrimaryNode HTTP API server —
 * unconditionally. The Unix-socket probe (existsSync + createConnection) and
 * `getIpcSocketPath` discovery are gone with the transport, so these tests
 * pin the REST contract, including that `DISCLAUDE_REST_IPC_ENABLED` no
 * longer gates anything (unset and 'false' behave like 'true': REST is the
 * only transport).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks shared across vi.doMock factories.
const { mockLogger, mockCreateLogger } = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockCreateLogger = vi.fn().mockReturnValue(mockLogger);
  return { mockLogger, mockCreateLogger };
});

// Hoisted RestIpcClient class mock — vi.doMock factories can close over it.
const { MockRestIpcClient } = vi.hoisted(() => {
  class MockRestIpcClientImpl {
    constructor(public opts: { baseUrl?: string; apiToken?: string }) {}
  }
  return { MockRestIpcClient: MockRestIpcClientImpl };
});
// The factory's declared return type is the real RestIpcClient; assertions
// inspect the mock's captured constructor opts via this structural type.
type MockRestIpcClient = { opts: { baseUrl?: string; apiToken?: string } };

async function loadModule() {
  // vi.clearAllMocks() (run by sibling describes' afterEach) wipes the
  // mockReturnValue wiring — re-arm it on every load.
  mockCreateLogger.mockReturnValue(mockLogger);
  vi.doMock('@disclaude/core', () => ({
    createLogger: (...args: unknown[]) => mockCreateLogger(...args),
    RestIpcClient: MockRestIpcClient,
  }));
  vi.resetModules();
  return await import('./ipc-utils.js');
}

describe('getIpcErrorMessage', () => {
  let getIpcErrorMessage: typeof import('./ipc-utils.js').getIpcErrorMessage;

  beforeEach(async () => {
    ({ getIpcErrorMessage } = await loadModule());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  describe('ipc_unavailable error type', () => {
    it('should return an actionable REST message (mentions --api-port)', () => {
      const message = getIpcErrorMessage('ipc_unavailable');
      expect(message).toContain('❌');
      expect(message).toContain('--api-port');
      expect(message).toContain('DISCLAUDE_REST_IPC_BASE_URL');
    });

    it('should ignore originalError for ipc_unavailable', () => {
      const message = getIpcErrorMessage('ipc_unavailable', 'ECONNREFUSED');
      expect(message).not.toContain('ECONNREFUSED');
    });

    it('should ignore defaultMessage for ipc_unavailable', () => {
      const message = getIpcErrorMessage('ipc_unavailable', undefined, 'default');
      expect(message).not.toContain('default');
    });
  });

  describe('ipc_timeout error type', () => {
    it('should return timeout message', () => {
      const message = getIpcErrorMessage('ipc_timeout');
      expect(message).toContain('超时');
    });

    it('should ignore originalError for ipc_timeout', () => {
      const message = getIpcErrorMessage('ipc_timeout', 'ETIMEDOUT detail');
      expect(message).not.toContain('ETIMEDOUT');
    });
  });

  describe('ipc_request_failed error type', () => {
    it('should return request failed message with original error', () => {
      const message = getIpcErrorMessage('ipc_request_failed', 'boom');
      expect(message).toContain('boom');
    });

    it('should return request failed message without original error', () => {
      const message = getIpcErrorMessage('ipc_request_failed');
      expect(message).toContain('未知错误');
    });
  });

  describe('default/unknown error type', () => {
    it('should return default message when no error type is provided', () => {
      const message = getIpcErrorMessage();
      expect(message).toContain('操作失败');
    });

    it('should return original error in default message when no defaultMessage is provided', () => {
      const message = getIpcErrorMessage(undefined, 'oops');
      expect(message).toContain('oops');
    });

    it('should handle unknown error type', () => {
      const message = getIpcErrorMessage('weird_type', 'detail');
      expect(message).toContain('detail');
    });

    it('should prefer defaultMessage over generated message for unknown types', () => {
      const message = getIpcErrorMessage('weird_type', 'detail', 'use this');
      expect(message).toBe('use this');
    });
  });
});

describe('buildIpcFallbackHint (Issue #4576)', () => {
  let buildIpcFallbackHint: typeof import('./ipc-utils.js').buildIpcFallbackHint;

  beforeEach(async () => {
    ({ buildIpcFallbackHint } = await loadModule());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should point at +messages-reply (thread-preserving), not +messages-send', () => {
    const hint = buildIpcFallbackHint();
    expect(hint).toContain('+messages-reply');
    expect(hint).not.toContain('+messages-send --');
  });

  it('should embed the concrete parentMessageId when provided', () => {
    const hint = buildIpcFallbackHint('om_x100b6788c7ec08a8c26e10b5b77637a');
    expect(hint).toContain('--message-id om_x100b6788c7ec08a8c26e10b5b77637a');
  });

  it('should use a generic placeholder when no parentMessageId', () => {
    const hint = buildIpcFallbackHint();
    expect(hint).toContain('--message-id <om_...>');
  });

  it('should append --file when filePath is provided (send_file caller)', () => {
    const hint = buildIpcFallbackHint('om_parent123', { filePath: './report.pdf' });
    expect(hint).toContain('+messages-reply --message-id om_parent123 --file ./report.pdf');
  });

  it('should omit --file when no filePath (text/card/interactive callers unchanged)', () => {
    const hint = buildIpcFallbackHint('om_parent123');
    expect(hint).not.toContain('--file');
  });
});

describe('isIpcAvailable (REST-only)', () => {
  let isIpcAvailable: typeof import('./ipc-utils.js').isIpcAvailable;
  let originalFetch: typeof globalThis.fetch;
  let savedBaseUrl: string | undefined;
  let savedRestEnabled: string | undefined;

  async function loadWithPing(ping: typeof globalThis.fetch) {
    globalThis.fetch = ping;
    ({ isIpcAvailable } = await loadModule());
  }

  beforeEach(() => {
    savedBaseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;
    savedRestEnabled = process.env.DISCLAUDE_REST_IPC_ENABLED;
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_ENABLED;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (savedBaseUrl === undefined) { delete process.env.DISCLAUDE_REST_IPC_BASE_URL; }
    else { process.env.DISCLAUDE_REST_IPC_BASE_URL = savedBaseUrl; }
    if (savedRestEnabled === undefined) { delete process.env.DISCLAUDE_REST_IPC_ENABLED; }
    else { process.env.DISCLAUDE_REST_IPC_ENABLED = savedRestEnabled; }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should return true when REST /api/ping responds with { pong: true }', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isIpcAvailable();
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:19200/api/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return true with all env unset — no toggle gates REST (acceptance #1)', async () => {
    // DISCLAUDE_REST_IPC_ENABLED explicitly unset above; REST must still be probed.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);
    expect(await isIpcAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('should ignore DISCLAUDE_REST_IPC_ENABLED=false — still probes REST (acceptance #2)', async () => {
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);
    expect(await isIpcAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:19200/api/ping',
      expect.anything(),
    );
  });

  it('should honor DISCLAUDE_REST_IPC_BASE_URL (and strip trailing slash)', async () => {
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://127.0.0.1:9999/';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);

    expect(await isIpcAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/api/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return false when ping responds without pong', async () => {
    await loadWithPing(vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: false }),
    }) as unknown as typeof globalThis.fetch);
    expect(await isIpcAvailable()).toBe(false);
  });

  it('should return false when ping responds non-2xx', async () => {
    await loadWithPing(vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => ({}),
    }) as unknown as typeof globalThis.fetch);
    expect(await isIpcAvailable()).toBe(false);
  });

  it('should return false when fetch throws (PrimaryNode not running)', async () => {
    await loadWithPing(vi.fn().mockRejectedValue(
      new Error('ECONNREFUSED'),
    ) as unknown as typeof globalThis.fetch);
    expect(await isIpcAvailable()).toBe(false);
  });
});

describe('getRestIpcClient (REST-only construction)', () => {
  let getRestIpcClient: typeof import('./ipc-utils.js').getRestIpcClient;
  let savedBaseUrl: string | undefined;
  let savedApiToken: string | undefined;

  beforeEach(async () => {
    savedBaseUrl = process.env.DISCLAUDE_REST_IPC_BASE_URL;
    savedApiToken = process.env.DISCLAUDE_REST_IPC_API_TOKEN;
    delete process.env.DISCLAUDE_REST_IPC_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_API_TOKEN;
    ({ getRestIpcClient } = await loadModule());
  });

  afterEach(async () => {
    if (savedBaseUrl === undefined) { delete process.env.DISCLAUDE_REST_IPC_BASE_URL; }
    else { process.env.DISCLAUDE_REST_IPC_BASE_URL = savedBaseUrl; }
    if (savedApiToken === undefined) { delete process.env.DISCLAUDE_REST_IPC_API_TOKEN; }
    else { process.env.DISCLAUDE_REST_IPC_API_TOKEN = savedApiToken; }
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should construct a RestIpcClient directly with all env unset (no IPC fallback)', () => {
    const client = getRestIpcClient() as unknown as MockRestIpcClient;
    expect(client).toBeInstanceOf(MockRestIpcClient);
    expect(client.opts.baseUrl).toBe('http://localhost:19200');
  });

  it('should wire DISCLAUDE_REST_IPC_BASE_URL / _API_TOKEN into the client', () => {
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://10.0.0.5:9300';
    process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'secret-token';
    const client = getRestIpcClient() as unknown as MockRestIpcClient;
    expect(client.opts.baseUrl).toBe('http://10.0.0.5:9300');
    expect(client.opts.apiToken).toBe('secret-token');
  });

  it('should strip a trailing slash from the base URL', () => {
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://10.0.0.5:9300/';
    const client = getRestIpcClient() as unknown as MockRestIpcClient;
    expect(client.opts.baseUrl).toBe('http://10.0.0.5:9300');
  });

  it('should be unaffected by DISCLAUDE_REST_IPC_ENABLED', () => {
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
    const on = getRestIpcClient() as unknown as MockRestIpcClient;
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
    const off = getRestIpcClient() as unknown as MockRestIpcClient;
    expect(on.opts.baseUrl).toBe('http://localhost:19200');
    expect(off.opts.baseUrl).toBe('http://localhost:19200');
  });
});

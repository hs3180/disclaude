/**
 * Tests for channel-cli/tools/channel-api-utils (Issue #4280 Phase 3 part 3: REST-only).
 *
 * `isChannelApiAvailable` probes `GET /api/ping` on the DisclaudeService HTTP API server —
 * unconditionally. The Unix-socket probe (existsSync + createConnection) and
 * `getChannelApiSocketPath` discovery are gone with the transport, so these tests
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

// Hoisted ChannelApiClient class mock — vi.doMock factories can close over it.
const { MockChannelApiClient } = vi.hoisted(() => {
  class MockChannelApiClientImpl {
    constructor(public opts: { baseUrl?: string; apiToken?: string }) {}
  }
  return { MockChannelApiClient: MockChannelApiClientImpl };
});
// The factory's declared return type is the real ChannelApiClient; assertions
// inspect the mock's captured constructor opts via this structural type.
type MockChannelApiClient = { opts: { baseUrl?: string; apiToken?: string } };

async function loadModule() {
  // vi.clearAllMocks() (run by sibling describes' afterEach) wipes the
  // mockReturnValue wiring — re-arm it on every load.
  mockCreateLogger.mockReturnValue(mockLogger);
  vi.doMock('@disclaude/core', () => ({
    createLogger: (...args: unknown[]) => mockCreateLogger(...args),
    ChannelApiClient: MockChannelApiClient,
    normalizeChannelApiBaseUrl: (value: string) => {
      if (!value) { throw new Error('DisclaudeService REST address is required'); }
      return new URL(value).origin;
    },
  }));
  vi.resetModules();
  return await import('./channel-api-utils.js');
}

describe('getChannelApiErrorMessage', () => {
  let getChannelApiErrorMessage: typeof import('./channel-api-utils.js').getChannelApiErrorMessage;

  beforeEach(async () => {
    ({ getChannelApiErrorMessage } = await loadModule());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  describe('channel_api_unavailable error type', () => {
    it('should return an actionable REST message (mentions --api-port)', () => {
      const message = getChannelApiErrorMessage('channel_api_unavailable');
      expect(message).toContain('❌');
      expect(message).toContain('--api-port');
      expect(message).toContain('DISCLAUDE_API_BASE_URL');
    });

    it('should ignore originalError for channel_api_unavailable', () => {
      const message = getChannelApiErrorMessage('channel_api_unavailable', 'ECONNREFUSED');
      expect(message).not.toContain('ECONNREFUSED');
    });

    it('should ignore defaultMessage for channel_api_unavailable', () => {
      const message = getChannelApiErrorMessage('channel_api_unavailable', undefined, 'default');
      expect(message).not.toContain('default');
    });
  });

  describe('channel_api_timeout error type', () => {
    it('should return timeout message', () => {
      const message = getChannelApiErrorMessage('channel_api_timeout');
      expect(message).toContain('超时');
    });

    it('should ignore originalError for channel_api_timeout', () => {
      const message = getChannelApiErrorMessage('channel_api_timeout', 'ETIMEDOUT detail');
      expect(message).not.toContain('ETIMEDOUT');
    });
  });

  describe('channel_api_request_failed error type', () => {
    it('should return request failed message with original error', () => {
      const message = getChannelApiErrorMessage('channel_api_request_failed', 'boom');
      expect(message).toContain('boom');
    });

    it('should return request failed message without original error', () => {
      const message = getChannelApiErrorMessage('channel_api_request_failed');
      expect(message).toContain('未知错误');
    });
  });

  describe('default/unknown error type', () => {
    it('should return default message when no error type is provided', () => {
      const message = getChannelApiErrorMessage();
      expect(message).toContain('操作失败');
    });

    it('should return original error in default message when no defaultMessage is provided', () => {
      const message = getChannelApiErrorMessage(undefined, 'oops');
      expect(message).toContain('oops');
    });

    it('should handle unknown error type', () => {
      const message = getChannelApiErrorMessage('weird_type', 'detail');
      expect(message).toContain('detail');
    });

    it('should prefer defaultMessage over generated message for unknown types', () => {
      const message = getChannelApiErrorMessage('weird_type', 'detail', 'use this');
      expect(message).toBe('use this');
    });
  });
});

describe('buildChannelApiFallbackHint (Issue #4576)', () => {
  let buildChannelApiFallbackHint: typeof import('./channel-api-utils.js').buildChannelApiFallbackHint;

  beforeEach(async () => {
    ({ buildChannelApiFallbackHint } = await loadModule());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should point at +messages-reply (thread-preserving), not +messages-send', () => {
    const hint = buildChannelApiFallbackHint();
    expect(hint).toContain('+messages-reply');
    expect(hint).not.toContain('+messages-send --');
  });

  it('should embed the concrete parentMessageId when provided', () => {
    const hint = buildChannelApiFallbackHint('om_x100b6788c7ec08a8c26e10b5b77637a');
    expect(hint).toContain('--message-id om_x100b6788c7ec08a8c26e10b5b77637a');
  });

  it('should use a generic placeholder when no parentMessageId', () => {
    const hint = buildChannelApiFallbackHint();
    expect(hint).toContain('--message-id <om_...>');
  });

  it('should append --file when filePath is provided (send_file caller)', () => {
    const hint = buildChannelApiFallbackHint('om_parent123', { filePath: './report.pdf' });
    expect(hint).toContain('+messages-reply --message-id om_parent123 --file ./report.pdf');
  });

  it('should omit --file when no filePath (text/card/interactive callers unchanged)', () => {
    const hint = buildChannelApiFallbackHint('om_parent123');
    expect(hint).not.toContain('--file');
  });
});

describe('isChannelApiAvailable (REST-only)', () => {
  let isChannelApiAvailable: typeof import('./channel-api-utils.js').isChannelApiAvailable;
  let originalFetch: typeof globalThis.fetch;
  let savedBaseUrl: string | undefined;
  let savedRestEnabled: string | undefined;

  async function loadWithPing(ping: typeof globalThis.fetch) {
    globalThis.fetch = ping;
    ({ isChannelApiAvailable } = await loadModule());
  }

  beforeEach(() => {
    savedBaseUrl = process.env.DISCLAUDE_API_BASE_URL;
    savedRestEnabled = process.env.DISCLAUDE_REST_IPC_ENABLED;
    delete process.env.DISCLAUDE_API_BASE_URL;
    delete process.env.DISCLAUDE_REST_IPC_ENABLED;
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (savedBaseUrl === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; }
    else { process.env.DISCLAUDE_API_BASE_URL = savedBaseUrl; }
    if (savedRestEnabled === undefined) { delete process.env.DISCLAUDE_REST_IPC_ENABLED; }
    else { process.env.DISCLAUDE_REST_IPC_ENABLED = savedRestEnabled; }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should return true when REST /api/ping responds with { pong: true }', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);

    const result = await isChannelApiAvailable();
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19200/api/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should reject a missing REST address with all env unset', async () => {
    // DISCLAUDE_REST_IPC_ENABLED explicitly unset above; REST must still be probed.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);
    await expect(isChannelApiAvailable()).rejects.toThrow('DisclaudeService REST address is required');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should ignore DISCLAUDE_REST_IPC_ENABLED=false — still probes REST (acceptance #2)', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);
    expect(await isChannelApiAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:19200/api/ping',
      expect.anything(),
    );
  });

  it('should honor DISCLAUDE_API_BASE_URL (and strip trailing slash)', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:9999/';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: true }),
    });
    await loadWithPing(fetchMock as unknown as typeof globalThis.fetch);

    expect(await isChannelApiAvailable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/api/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('should return false when ping responds without pong', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    await loadWithPing(vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ pong: false }),
    }) as unknown as typeof globalThis.fetch);
    expect(await isChannelApiAvailable()).toBe(false);
  });

  it('should return false when ping responds non-2xx', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    await loadWithPing(vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: () => ({}),
    }) as unknown as typeof globalThis.fetch);
    expect(await isChannelApiAvailable()).toBe(false);
  });

  it('should return false when fetch throws (DisclaudeService not running)', async () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    await loadWithPing(vi.fn().mockRejectedValue(
      new Error('ECONNREFUSED'),
    ) as unknown as typeof globalThis.fetch);
    expect(await isChannelApiAvailable()).toBe(false);
  });
});

describe('getChannelApiClient (REST-only construction)', () => {
  let getChannelApiClient: typeof import('./channel-api-utils.js').getChannelApiClient;
  let savedBaseUrl: string | undefined;

  beforeEach(async () => {
    savedBaseUrl = process.env.DISCLAUDE_API_BASE_URL;
    delete process.env.DISCLAUDE_API_BASE_URL;
    ({ getChannelApiClient } = await loadModule());
  });

  afterEach(async () => {
    if (savedBaseUrl === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; }
    else { process.env.DISCLAUDE_API_BASE_URL = savedBaseUrl; }
    delete process.env.DISCLAUDE_API_TOKEN;
    vi.restoreAllMocks();
    await vi.resetModules();
  });

  it('should reject construction with all env unset', () => {
    expect(() => getChannelApiClient()).toThrow('DisclaudeService REST address is required');
  });

  it('does not discover an address or token through removed IPC variables', () => {
    const oldBase = process.env.DISCLAUDE_REST_IPC_BASE_URL;
    const oldToken = process.env.DISCLAUDE_REST_IPC_API_TOKEN;
    try {
      process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://127.0.0.1:49999';
      process.env.DISCLAUDE_REST_IPC_API_TOKEN = 'old-test-token';
      delete process.env.DISCLAUDE_API_TOKEN;
      expect(() => getChannelApiClient()).toThrow('DisclaudeService REST address is required');
      process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:49998';
      const client = getChannelApiClient() as unknown as MockChannelApiClient;
      expect(client.opts).toEqual({ baseUrl: 'http://127.0.0.1:49998', apiToken: undefined });
    } finally {
      if (oldBase === undefined) { delete process.env.DISCLAUDE_REST_IPC_BASE_URL; } else { process.env.DISCLAUDE_REST_IPC_BASE_URL = oldBase; }
      if (oldToken === undefined) { delete process.env.DISCLAUDE_REST_IPC_API_TOKEN; } else { process.env.DISCLAUDE_REST_IPC_API_TOKEN = oldToken; }
    }
  });

  it('should wire the REST base URL into the client without local auth state', () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://10.0.0.5:9300';
    const client = getChannelApiClient() as unknown as MockChannelApiClient;
    expect(client.opts.baseUrl).toBe('http://10.0.0.5:9300');
  });

  it('should strip a trailing slash from the base URL', () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://10.0.0.5:9300/';
    const client = getChannelApiClient() as unknown as MockChannelApiClient;
    expect(client.opts.baseUrl).toBe('http://10.0.0.5:9300');
  });

  it('should be unaffected by DISCLAUDE_REST_IPC_ENABLED', () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'true';
    const on = getChannelApiClient() as unknown as MockChannelApiClient;
    process.env.DISCLAUDE_REST_IPC_ENABLED = 'false';
    const off = getChannelApiClient() as unknown as MockChannelApiClient;
    expect(on.opts.baseUrl).toBe('http://127.0.0.1:19200');
    expect(off.opts.baseUrl).toBe('http://127.0.0.1:19200');
  });

  // Issue #4801 (P0): when the service runs with --api-token, the client must
  // attach the bearer token so channel writes don't 401 while the (token-exempt)
  // GET /api/ping probe reports "available".
  it('should forward DISCLAUDE_API_TOKEN as the API token', () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    process.env.DISCLAUDE_API_TOKEN = 'tok-123';
    const client = getChannelApiClient() as unknown as MockChannelApiClient;
    expect(client.opts.apiToken).toBe('tok-123');
  });

  it('should leave apiToken undefined when the env token is absent', () => {
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:19200';
    delete process.env.DISCLAUDE_API_TOKEN;
    const client = getChannelApiClient() as unknown as MockChannelApiClient;
    expect(client.opts.apiToken).toBeUndefined();
  });
});

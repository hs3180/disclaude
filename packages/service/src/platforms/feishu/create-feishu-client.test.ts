/**
 * Tests for createFeishuClient factory with retry logic (Issue #507).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { createFeishuClient } from './create-feishu-client.js';

// Mock FEISHU_API constants - use vi.hoisted to ensure initialization before mock hoisting
const MOCK_FEISHU_API = vi.hoisted(() => ({
  REQUEST_TIMEOUT_MS: 30000,
  RETRY: {
    MAX_RETRIES: 3,
    INITIAL_DELAY_MS: 1000,
    MAX_DELAY_MS: 10000,
    BACKOFF_MULTIPLIER: 2,
  },
}));

// Mock axios
vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxiosInstance),
    isAxiosError: vi.fn((error) => error && error.isAxiosError === true),
  };
  return {
    default: mockAxios,
  };
});

// Mock axios instance
const mockAxiosInstance = {
  request: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
  head: vi.fn(),
  options: vi.fn(),
};

// Shared logger mock so failure-path tests can assert on the structured record
const MOCK_LOGGER = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  FEISHU_API: MOCK_FEISHU_API,
  RETRYABLE_ERROR_CODES: ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'],
  createLogger: () => MOCK_LOGGER,
  sanitizeDiagnosticText: (text: string) => text,
}));

describe('createFeishuClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: successful response
    mockAxiosInstance.get.mockResolvedValue({ data: 'success' });
    mockAxiosInstance.post.mockResolvedValue({ data: 'success' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Ensure fake timers are always restored to prevent flaky tests
    vi.useRealTimers();
  });

  it('should create client with correct timeout configuration', () => {
    createFeishuClient('test-app-id', 'test-app-secret');

    expect(axios.create).toHaveBeenCalledWith({
      timeout: MOCK_FEISHU_API.REQUEST_TIMEOUT_MS,
    });
  });

  describe('retry logic', () => {
    it.each([
      ['post', 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', undefined],
      ['post', 'https://open.feishu.cn/open-apis/im/v1/messages/om_owned/reply', 503],
      ['request', 'https://open.feishu.cn/open-apis/im/v1/messages', 500],
      ['request', '/open-apis/im/v1/messages/om_owned/reply', undefined],
    ])('does not replay an uncertain message via %s (%s)', async (method, url, status) => {
      const error = { isAxiosError: true, code: 'ECONNRESET', message: 'Message receipt unavailable', response: status ? { status } : undefined };
      const transport = method === 'post' ? mockAxiosInstance.post : mockAxiosInstance.request;
      transport.mockReset().mockResolvedValue({ data: 'duplicate' }).mockRejectedValueOnce(error);
      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { post: (url: string, data: unknown) => Promise<unknown>; request: (options: { url: string; method: string; data: unknown }) => Promise<unknown> } }).httpInstance;
      const result = method === 'post' ? http.post(url, { content: 'report' }) : http.request({ url, method: 'POST', data: { content: 'report' } });
      await expect(result).rejects.toBe(error);
      expect(transport).toHaveBeenCalledOnce();
    });

    it('retries a message after an explicit HTTP 429 rejection', async () => {
      const error = { isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status: 429 } };
      mockAxiosInstance.post.mockRejectedValueOnce(error).mockResolvedValueOnce({ data: 'confirmed' });
      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { post: (url: string, data: unknown) => Promise<unknown> } }).httpInstance;
      vi.useFakeTimers();
      const result = http.post('https://open.feishu.cn/open-apis/im/v1/messages/om_owned/reply', { content: 'report' });
      await vi.runAllTimersAsync();
      expect(await result).toBe('confirmed');
      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
    });

    it('should retry on ETIMEDOUT error', async () => {
      const timeoutError = {
        isAxiosError: true,
        code: 'ETIMEDOUT',
        message: 'timeout of 30000ms exceeded',
        response: undefined,
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError)
        .mockResolvedValueOnce({ data: 'success after retries' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      // Speed up test by mocking setTimeout
      vi.useFakeTimers();
      const resultPromise = httpInstance.get('https://test.com');

      // Fast-forward through delays
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      vi.useRealTimers();

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(3);
      expect(result).toBe('success after retries');
    });

    it('should retry on ECONNRESET error', async () => {
      const connResetError = {
        isAxiosError: true,
        code: 'ECONNRESET',
        message: 'socket hang up',
        response: undefined,
      };

      mockAxiosInstance.post
        .mockRejectedValueOnce(connResetError)
        .mockResolvedValueOnce({ data: 'success' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        post: (url: string, data: unknown) => Promise<unknown>;
      };

      vi.useFakeTimers();
      const resultPromise = httpInstance.post('https://test.com', { foo: 'bar' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(mockAxiosInstance.post).toHaveBeenCalledTimes(2);
      expect(result).toBe('success');
    });

    it('should retry on 5xx server errors', async () => {
      const serverError = {
        isAxiosError: true,
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 500',
        response: { status: 500, data: 'Internal Server Error' },
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ data: 'success' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      vi.useFakeTimers();
      const resultPromise = httpInstance.get('https://test.com');
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(result).toBe('success');
    });

    it('should retry on 429 Too Many Requests', async () => {
      const rateLimitError = {
        isAxiosError: true,
        code: 'ERR_BAD_RESPONSE',
        message: 'Request failed with status code 429',
        response: { status: 429, data: 'Rate limited' },
      };

      mockAxiosInstance.get
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: 'success' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      vi.useFakeTimers();
      const resultPromise = httpInstance.get('https://test.com');
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      vi.useRealTimers();

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(2);
      expect(result).toBe('success');
    });

    it('should NOT retry on 4xx client errors (except 429)', async () => {
      const badRequestError = {
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        message: 'Request failed with status code 400',
        response: { status: 400, data: 'Bad Request' },
      };

      mockAxiosInstance.get.mockRejectedValue(badRequestError);

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      await expect(httpInstance.get('https://test.com')).rejects.toBeDefined();

      // Should not retry for 4xx errors
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retries exhausted', async () => {
      const timeoutError = {
        isAxiosError: true,
        code: 'ETIMEDOUT',
        message: 'timeout of 30000ms exceeded',
        response: undefined,
      };

      // All attempts fail
      mockAxiosInstance.get.mockRejectedValue(timeoutError);

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      // Set very short delays for testing (override the default backoff)
      vi.useFakeTimers();

      // Start the request
      const resultPromise = httpInstance.get('https://test.com');

      // Wait for the promise to settle (including all retries)
      // Using vi.waitFor handles the async nature properly
      let error: unknown;
      resultPromise.catch(e => { error = e; });

      // Run all pending timers and wait for the promise to settle
      await vi.runAllTimersAsync();

      // Small additional wait to ensure promise rejection is processed
      await Promise.resolve();

      vi.useRealTimers();

      // Verify error was caught
      expect(error).toBeDefined();
      expect(error).toHaveProperty('code', 'ETIMEDOUT');

      // Initial attempt + MAX_RETRIES (3) = 4 total calls
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1 + MOCK_FEISHU_API.RETRY.MAX_RETRIES);
    });

    it('should use exponential backoff for delays', async () => {
      const timeoutError = {
        isAxiosError: true,
        code: 'ETIMEDOUT',
        message: 'timeout',
        response: undefined,
      };

      mockAxiosInstance.get.mockRejectedValue(timeoutError);

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const httpInstance = (client as unknown as { httpInstance: unknown }).httpInstance as {
        get: (url: string) => Promise<unknown>;
      };

      vi.useFakeTimers();

      // Start the request with catch to prevent unhandled rejection
      const resultPromise = httpInstance.get('https://test.com').catch(e => e);

      // Let it run through all retries
      await vi.runAllTimersAsync();

      // Await and verify it failed
      const result = await resultPromise;
      expect(result).toBeDefined();

      vi.useRealTimers();

      // Verify it attempted multiple times (exponential backoff would cause delays)
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1 + MOCK_FEISHU_API.RETRY.MAX_RETRIES);
    });
  });

  describe('HTTP failure forensics (#5655)', () => {
    const feishu500Error = () => ({
      isAxiosError: true,
      code: 'ERR_BAD_RESPONSE',
      message: 'Request failed with status code 500',
      config: {
        method: 'post',
        url: 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
        data: { receive_id: 'oc_test', content: JSON.stringify({ text: `chat content ${'x'.repeat(3000)}` }) },
      },
      response: {
        status: 500,
        headers: {
          'x-request-id': 'req-1682389753AbCdEf',
          'content-type': 'application/json',
          'set-cookie': 'secret-cookie-value',
        },
        data: { code: 99991663, msg: 'Internal app server error' },
      },
    });

    it('logs one structured record (method/URL/status/headers subset/bodies) for an unretried message POST 5xx', async () => {
      const error = feishu500Error();
      mockAxiosInstance.post.mockReset().mockRejectedValueOnce(error).mockResolvedValue({ data: 'duplicate' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { post: (url: string, data: unknown) => Promise<unknown> } }).httpInstance;

      await expect(http.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', error.config.data))
        .rejects.toBe(error);

      // #507 semantics preserved: message POST 5xx is never replayed
      expect(mockAxiosInstance.post).toHaveBeenCalledOnce();

      expect(MOCK_LOGGER.error).toHaveBeenCalledTimes(1);
      expect(MOCK_LOGGER.error.mock.calls[0]).toMatchObject([
        expect.objectContaining({
          method: 'POST',
          url: error.config.url,
          status: 500,
          // Allowlisted response headers only, never cookies
          responseHeaders: { 'x-request-id': 'req-1682389753AbCdEf' },
          // Feishu error structure survives into the body log
          responseBody: expect.stringContaining('99991663'),
        }),
        'Feishu channel HTTP request failed (no retry)',
      ]);
      expect(MOCK_LOGGER.error.mock.calls[0][0].context).toContain('/im/v1/messages');
      expect(String(MOCK_LOGGER.error.mock.calls[0][0].responseBody)).toContain('Internal app server error');
      // Request body is truncated well before the 3000-char chat content ends
      const loggedRequestBody = String(MOCK_LOGGER.error.mock.calls[0][0].requestBody);
      expect(loggedRequestBody.length).toBeLessThanOrEqual(600);
      expect(loggedRequestBody).toContain('[truncated');
    });

    it('appends the Feishu business code/msg to the thrown error message for ❌ notifications and scheduler pass-through', async () => {
      const error = feishu500Error();
      mockAxiosInstance.post.mockReset().mockRejectedValueOnce(error);

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { post: (url: string, data: unknown) => Promise<unknown> } }).httpInstance;

      await expect(http.post('https://open.feishu.cn/open-apis/im/v1/messages', {})).rejects.toThrow(
        /feishu code 99991663: Internal app server error/
      );
    });

    it('keeps the full forensic record on the all-retries-exhausted path (GET 5xx)', async () => {
      const error = { ...feishu500Error(), config: { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/chats', data: undefined } };
      mockAxiosInstance.get.mockReset().mockRejectedValue(error);

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { get: (url: string) => Promise<unknown> } }).httpInstance;

      vi.useFakeTimers();
      const resultPromise = http.get('https://open.feishu.cn/open-apis/im/v1/chats').catch(e => e);
      await vi.runAllTimersAsync();
      const thrown = await resultPromise;
      vi.useRealTimers();

      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1 + MOCK_FEISHU_API.RETRY.MAX_RETRIES);
      expect(MOCK_LOGGER.error).toHaveBeenCalledWith(
        expect.objectContaining({
          context: expect.stringContaining('get'),
          status: 500,
          method: 'GET',
          responseHeaders: { 'x-request-id': 'req-1682389753AbCdEf' },
        }),
        'All retry attempts exhausted'
      );
      expect((thrown as Error).message).toContain('feishu code 99991663');
    });

    it('does not annotate or mislabel non-Feishu-body errors', async () => {
      const error = {
        isAxiosError: true,
        code: 'ETIMEDOUT',
        message: 'timeout of 30000ms exceeded',
        config: { method: 'get', url: 'https://open.feishu.cn/open-apis/im/v1/chats' },
        response: undefined,
      };
      mockAxiosInstance.get.mockReset().mockRejectedValueOnce(error).mockResolvedValueOnce({ data: 'ok' });

      const client = createFeishuClient('test-app-id', 'test-app-secret');
      const http = (client as unknown as { httpInstance: { get: (url: string) => Promise<unknown> } }).httpInstance;

      vi.useFakeTimers();
      const resultPromise = http.get('https://open.feishu.cn/open-apis/im/v1/chats');
      await vi.runAllTimersAsync();
      await resultPromise;
      vi.useRealTimers();

      expect(error.message).toBe('timeout of 30000ms exceeded');
    });
  });
});

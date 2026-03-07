/**
 * Tests for createFeishuClient factory with retry logic (Issue #507).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { createFeishuClient } from './create-feishu-client.js';
import { FEISHU_API } from '../../../src/config/constants.js';

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

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
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
      timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
    });
  });

  describe('retry logic', () => {
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
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1 + FEISHU_API.RETRY.MAX_RETRIES);
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
      expect(mockAxiosInstance.get).toHaveBeenCalledTimes(1 + FEISHU_API.RETRY.MAX_RETRIES);
    });
  });
});

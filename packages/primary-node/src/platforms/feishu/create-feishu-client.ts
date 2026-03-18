/**
 * Factory function to create Lark Client with timeout and retry configuration.
 *
 * The @larksuiteoapi/node-sdk doesn't support requestTimeout directly,
 * so we create a custom axios instance with timeout and wrap it as HttpInstance.
 *
 * Retry mechanism (Issue #507):
 * - Automatically retries on transient network errors (ETIMEDOUT, ECONNRESET, etc.)
 * - Uses exponential backoff with jitter to avoid thundering herd
 * - Logs retry attempts for debugging
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import * as lark from '@larksuiteoapi/node-sdk';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { FEISHU_API, RETRYABLE_ERROR_CODES, createLogger } from '@disclaude/core';

const logger = createLogger('FeishuClient');

/**
 * Check if an error is retryable (transient network error).
 */
function isRetryableError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }

  const axiosError = error as AxiosError;

  // Network errors (no response received)
  if (!axiosError.response && axiosError.code) {
    return RETRYABLE_ERROR_CODES.includes(axiosError.code as typeof RETRYABLE_ERROR_CODES[number]);
  }

  // Server errors (5xx) are potentially retryable
  if (axiosError.response?.status) {
    const { status } = axiosError.response;
    // 429 Too Many Requests, 500+ server errors
    return status === 429 || (status >= 500 && status < 600);
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter.
 * This helps avoid thundering herd problem when multiple clients retry simultaneously.
 */
function calculateRetryDelay(attempt: number): number {
  const { INITIAL_DELAY_MS, MAX_DELAY_MS, BACKOFF_MULTIPLIER } = FEISHU_API.RETRY;
  const exponentialDelay = INITIAL_DELAY_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
  const cappedDelay = Math.min(exponentialDelay, MAX_DELAY_MS);
  // Add jitter (random 0-20% of delay) to spread out retries
  const jitter = cappedDelay * Math.random() * 0.2;
  return Math.floor(cappedDelay + jitter);
}

/**
 * Sleep for specified milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap axios request with retry logic.
 */
async function requestWithRetry<T>(
  requestFn: () => Promise<T>,
  context: string
): Promise<T> {
  const { MAX_RETRIES } = FEISHU_API.RETRY;
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;

      // Check if we should retry
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't sleep after the last attempt
      if (attempt < MAX_RETRIES) {
        const delay = calculateRetryDelay(attempt);
        const axiosError = error as AxiosError;
        logger.warn(
          {
            context,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            delayMs: delay,
            errorCode: axiosError.code,
            errorMessage: axiosError.message,
          },
          'Request failed, retrying...'
        );
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  const axiosError = lastError as AxiosError;
  logger.error(
    {
      context,
      maxRetries: MAX_RETRIES,
      errorCode: axiosError?.code,
      errorMessage: axiosError?.message,
    },
    'All retry attempts exhausted'
  );
  throw lastError;
}

/**
 * Wrap an axios instance to match lark SDK's HttpInstance interface.
 * Includes retry logic for transient errors.
 */
/**
 * Process axios response, handling $return_headers option used by lark SDK.
 *
 * The lark SDK's default HTTP instance checks `resp.config['$return_headers']`
 * via a response interceptor to return `{ data, headers }` instead of just `data`.
 * Our custom wrapper needs to replicate this behavior, particularly for
 * `im.messageResource.get()` which downloads files via streams.
 */
function processResponse<T>(res: { data: T; headers: Record<string, unknown> }, opts: Record<string, unknown>): T | { data: T; headers: Record<string, unknown> } {
  if (opts.$return_headers) {
    return { data: res.data, headers: res.headers };
  }
  return res.data;
}

function wrapAxiosAsHttpInstance(axiosInstance: AxiosInstance): lark.HttpInstance {
  return {
    request: async (opts) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawOpts = opts as any;
      return await requestWithRetry(
        () => axiosInstance.request({
          url: opts.url,
          method: opts.method,
          headers: opts.headers,
          params: opts.params,
          data: opts.data,
          responseType: opts.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
          timeout: opts.timeout,
        }).then(res => processResponse(res, rawOpts)),
        `request ${opts.method} ${opts.url}`
      );
    },
    get: async (url, opts) => {
      return await requestWithRetry(
        () => axiosInstance.get(url, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `get ${url}`
      );
    },
    delete: async (url, opts) => {
      return await requestWithRetry(
        () => axiosInstance.delete(url, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `delete ${url}`
      );
    },
    head: async (url, opts) => {
      return await requestWithRetry(
        () => axiosInstance.head(url, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `head ${url}`
      );
    },
    options: async (url, opts) => {
      return await requestWithRetry(
        () => axiosInstance.options(url, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `options ${url}`
      );
    },
    post: async (url, data, opts) => {
      return await requestWithRetry(
        () => axiosInstance.post(url, data, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `post ${url}`
      );
    },
    put: async (url, data, opts) => {
      return await requestWithRetry(
        () => axiosInstance.put(url, data, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `put ${url}`
      );
    },
    patch: async (url, data, opts) => {
      return await requestWithRetry(
        () => axiosInstance.patch(url, data, {
          params: opts?.params,
          headers: opts?.headers,
          timeout: opts?.timeout,
          responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        }).then(res => res.data),
        `patch ${url}`
      );
    },
  };
}

/**
 * Options for creating a Feishu client.
 */
export interface CreateFeishuClientOptions {
  /** API domain (Feishu or Lark) */
  domain?: lark.Domain | string;
  /** Custom logger instance */
  logger?: unknown;
  /** Logger level */
  loggerLevel?: lark.LoggerLevel;
}

/**
 * Create a Lark Client with configured request timeout and retry.
 *
 * @param appId - Feishu App ID
 * @param appSecret - Feishu App Secret
 * @param options - Optional configuration
 * @returns Configured Lark Client instance
 */
export function createFeishuClient(
  appId: string,
  appSecret: string,
  options?: CreateFeishuClientOptions
): lark.Client {
  // Create axios instance with default timeout
  const axiosInstance = axios.create({
    timeout: FEISHU_API.REQUEST_TIMEOUT_MS,
  });

  // Wrap axios as lark HttpInstance (with retry logic)
  const httpInstance = wrapAxiosAsHttpInstance(axiosInstance);

  // Create and return lark Client with custom httpInstance
  return new lark.Client({
    appId,
    appSecret,
    domain: options?.domain ?? lark.Domain.Feishu,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger: options?.logger as any,
    loggerLevel: options?.loggerLevel,
    httpInstance,
  });
}

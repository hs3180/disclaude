/**
 * Factory function to create Lark Client with timeout configuration.
 *
 * The @larksuiteoapi/node-sdk doesn't support requestTimeout directly,
 * so we create a custom axios instance with timeout and wrap it as HttpInstance.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import axios, { AxiosInstance } from 'axios';
import { FEISHU_API } from '../../config/constants.js';

/**
 * Wrap an axios instance to match lark SDK's HttpInstance interface.
 */
function wrapAxiosAsHttpInstance(axiosInstance: AxiosInstance): lark.HttpInstance {
  return {
    request: async (opts) => {
      const response = await axiosInstance.request({
        url: opts.url,
        method: opts.method,
        headers: opts.headers,
        params: opts.params,
        data: opts.data,
        responseType: opts.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
        timeout: opts.timeout,
      });
      return response.data;
    },
    get: async (url, opts) => {
      const response = await axiosInstance.get(url, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    delete: async (url, opts) => {
      const response = await axiosInstance.delete(url, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    head: async (url, opts) => {
      const response = await axiosInstance.head(url, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    options: async (url, opts) => {
      const response = await axiosInstance.options(url, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    post: async (url, data, opts) => {
      const response = await axiosInstance.post(url, data, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    put: async (url, data, opts) => {
      const response = await axiosInstance.put(url, data, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
    },
    patch: async (url, data, opts) => {
      const response = await axiosInstance.patch(url, data, {
        params: opts?.params,
        headers: opts?.headers,
        timeout: opts?.timeout,
        responseType: opts?.responseType as 'arraybuffer' | 'blob' | 'document' | 'json' | 'text' | 'stream' | 'formdata' | undefined,
      });
      return response.data;
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
 * Create a Lark Client with configured request timeout.
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

  // Wrap axios as lark HttpInstance
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

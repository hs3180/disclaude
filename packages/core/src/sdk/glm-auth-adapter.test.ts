/**
 * Tests for GLM Auth Adapter (packages/core/src/sdk/glm-auth-adapter.ts)
 *
 * Tests the header transformation logic and server lifecycle.
 * Header transformation is tested via the exported `transformHeaders()` function
 * to avoid nock interference with HTTP forwarding tests.
 *
 * Issue #2916: Claude Code CLI 与 GLM API 认证失败
 */

import { describe, it, expect, afterEach } from 'vitest';
import { transformHeaders, start, stop, isRunning, getAdapterUrl, _reset } from './glm-auth-adapter.js';

describe('GLM Auth Adapter', () => {
  afterEach(async () => {
    await stop();
    _reset();
  });

  // ==========================================================================
  // Header Transformation Logic (pure function tests — no network)
  // ==========================================================================

  describe('transformHeaders()', () => {
    it('should transform Authorization: Bearer → x-api-key', () => {
      const result = transformHeaders({
        authorization: 'Bearer test-api-key-123',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      });

      expect(result['x-api-key']).toBe('test-api-key-123');
      expect(result['authorization']).toBeUndefined();
    });

    it('should preserve other headers', () => {
      const result = transformHeaders({
        authorization: 'Bearer key123',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'x-custom-header': 'custom-value',
      });

      expect(result['anthropic-version']).toBe('2023-06-01');
      expect(result['content-type']).toBe('application/json');
      expect(result['x-custom-header']).toBe('custom-value');
    });

    it('should remove x-anthropic-billing-header', () => {
      const result = transformHeaders({
        authorization: 'Bearer key123',
        'x-anthropic-billing-header': 'some-value',
        'content-type': 'application/json',
      });

      expect(result['x-anthropic-billing-header']).toBeUndefined();
    });

    it('should handle non-Bearer Authorization header', () => {
      const result = transformHeaders({
        authorization: 'Basic dXNlcjpwYXNz',
        'content-type': 'application/json',
      });

      // Non-Bearer auth is also transformed (strip the prefix and use as x-api-key)
      expect(result['x-api-key']).toBe('Basic dXNlcjpwYXNz');
      expect(result['authorization']).toBeUndefined();
    });

    it('should pass through x-api-key if already present (no Authorization)', () => {
      const result = transformHeaders({
        'x-api-key': 'direct-key',
        'content-type': 'application/json',
      });

      expect(result['x-api-key']).toBe('direct-key');
    });

    it('should remove host header', () => {
      const result = transformHeaders({
        host: 'localhost:12345',
        authorization: 'Bearer key123',
      });

      expect(result['host']).toBeUndefined();
      expect(result['x-api-key']).toBe('key123');
    });

    it('should remove connection header', () => {
      const result = transformHeaders({
        connection: 'keep-alive',
        authorization: 'Bearer key123',
      });

      expect(result['connection']).toBeUndefined();
    });

    it('should handle empty headers', () => {
      const result = transformHeaders({});
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should skip array-valued headers', () => {
      const result = transformHeaders({
        'accept': ['application/json', 'text/html'],
        authorization: 'Bearer key123',
      });

      expect(result['accept']).toBeUndefined();
      expect(result['x-api-key']).toBe('key123');
    });
  });

  // ==========================================================================
  // Server Lifecycle (start/stop tests — uses localhost servers)
  // ==========================================================================

  describe('start()', () => {
    it('should start adapter and return local URL', async () => {
      const url = await start('https://open.bigmodel.cn/api/anthropic');
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(isRunning()).toBe(true);
    });

    it('should return same URL on repeated start calls', async () => {
      const url1 = await start('https://open.bigmodel.cn/api/anthropic');
      const url2 = await start('https://open.bigmodel.cn/api/anthropic');
      expect(url1).toBe(url2);
    });

    it('should restart when target URL changes', async () => {
      const url1 = await start('https://open.bigmodel.cn/api/anthropic');
      const url2 = await start('https://other-api.example.com');
      expect(url1).not.toBe(url2);
    });
  });

  describe('stop()', () => {
    it('should stop the adapter', async () => {
      await start('https://open.bigmodel.cn/api/anthropic');
      expect(isRunning()).toBe(true);
      await stop();
      expect(isRunning()).toBe(false);
      expect(getAdapterUrl()).toBeNull();
    });

    it('should be idempotent', async () => {
      await stop(); // no-op
      await stop(); // still no-op
      expect(isRunning()).toBe(false);
    });
  });

  describe('getAdapterUrl()', () => {
    it('should return null when not running', () => {
      expect(getAdapterUrl()).toBeNull();
    });

    it('should return URL when running', async () => {
      const url = await start('https://open.bigmodel.cn/api/anthropic');
      expect(getAdapterUrl()).toBe(url);
    });
  });
});

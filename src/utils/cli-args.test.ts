/**
 * Tests for CLI argument parsing utilities.
 *
 * Note: Primary mode has been moved to @disclaude/primary-node package.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseGlobalArgs,
  getWorkerNodeConfig,
  type GlobalArgs,
} from './cli-args.js';

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getTransportConfig: vi.fn(() => ({
      http: {
        execution: { port: 3002, host: 'localhost' },
        communication: {
          callbackHost: 'localhost',
          callbackPort: 3001,
          executionUrl: 'ws://localhost:3002',
        },
        authToken: 'test-token',
      },
    })),
  },
}));

describe('cli-args', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('parseGlobalArgs', () => {
    it('should parse start command with worker mode', () => {
      const args = ['start', '--mode', 'worker'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('worker');
    });

    it('should return null mode for primary mode (moved to @disclaude/primary-node)', () => {
      const args = ['start', '--mode', 'primary'];
      const result = parseGlobalArgs(args);

      // primary mode is no longer supported in main package
      expect(result.mode).toBeNull();
    });

    it('should return null mode for invalid mode', () => {
      const args = ['start', '--mode', 'invalid'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBeNull();
    });

    it('should return null mode when mode is not specified', () => {
      const args = ['start'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBeNull();
    });

    it('should parse comm-url argument', () => {
      const args = ['start', '--mode', 'worker', '--comm-url', 'ws://example.com:3001'];
      const result = parseGlobalArgs(args);

      expect(result.commUrl).toBe('ws://example.com:3001');
    });

    it('should parse auth-token argument', () => {
      const args = ['start', '--mode', 'worker', '--auth-token', 'my-token'];
      const result = parseGlobalArgs(args);

      expect(result.authToken).toBe('my-token');
    });

    it('should use default values when arguments not provided', () => {
      const args: string[] = [];
      const result = parseGlobalArgs(args);

      expect(result.commUrl).toBe('ws://localhost:3001');
    });

    it('should handle multiple arguments', () => {
      const args = [
        'start',
        '--mode', 'worker',
        '--auth-token', 'secret',
        '--comm-url', 'ws://primary:3001',
      ];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('worker');
      expect(result.authToken).toBe('secret');
      expect(result.commUrl).toBe('ws://primary:3001');
    });
  });

  describe('getWorkerNodeConfig', () => {
    it('should extract worker node config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: 'worker',
        commUrl: 'ws://localhost:3001',
        authToken: 'test-token',
      };

      const config = getWorkerNodeConfig(globalArgs);

      expect(config.commUrl).toBe('ws://localhost:3001');
      expect(config.authToken).toBe('test-token');
    });
  });
});

/**
 * Tests for CLI argument parsing utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseGlobalArgs,
  getCommNodeConfig,
  getExecNodeConfig,
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
    getChannelsConfig: vi.fn(() => ({
      feishu: { enabled: false },
      rest: { enabled: true, port: 3000 },
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
    it('should parse start command with comm mode', () => {
      const args = ['start', '--mode', 'comm'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('comm');
    });

    it('should parse start command with exec mode', () => {
      const args = ['start', '--mode', 'exec'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('exec');
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

    it('should parse port argument', () => {
      const args = ['start', '--mode', 'exec', '--port', '4000'];
      const result = parseGlobalArgs(args);

      expect(result.port).toBe(4000);
    });

    it('should parse comm-url argument', () => {
      const args = ['start', '--mode', 'exec', '--comm-url', 'ws://example.com:3001'];
      const result = parseGlobalArgs(args);

      expect(result.commUrl).toBe('ws://example.com:3001');
    });

    it('should parse auth-token argument', () => {
      const args = ['start', '--mode', 'comm', '--auth-token', 'my-token'];
      const result = parseGlobalArgs(args);

      expect(result.authToken).toBe('my-token');
    });

    it('should use default values when arguments not provided', () => {
      const args: string[] = [];
      const result = parseGlobalArgs(args);

      expect(result.port).toBe(3001);
      expect(result.host).toBe('0.0.0.0');
      expect(result.commUrl).toBe('ws://localhost:3001');
    });

    it('should handle multiple arguments', () => {
      const args = [
        'start',
        '--mode', 'exec',
        '--port', '5000',
        '--auth-token', 'secret',
      ];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('exec');
      expect(result.port).toBe(5000);
      expect(result.authToken).toBe('secret');
    });
  });

  describe('getCommNodeConfig', () => {
    it('should extract comm node config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: 'comm',
        port: 3001,
        host: 'localhost',
        commUrl: 'ws://localhost:3001',
        authToken: 'test-token',
      };

      const config = getCommNodeConfig(globalArgs);

      expect(config.port).toBe(3001);
      expect(config.host).toBe('localhost');
      expect(config.authToken).toBe('test-token');
    });
  });

  describe('getExecNodeConfig', () => {
    it('should extract exec node config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: 'exec',
        port: 3001,
        host: 'localhost',
        commUrl: 'ws://localhost:3001',
        authToken: 'test-token',
      };

      const config = getExecNodeConfig(globalArgs);

      expect(config.commUrl).toBe('ws://localhost:3001');
      expect(config.authToken).toBe('test-token');
    });
  });
});

/**
 * Tests for CLI argument parsing utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseGlobalArgs,
  getCommNodeConfig,
  getExecNodeConfig,
  getCliModeConfig,
  type GlobalArgs,
} from './cli-args.js';

// Mock Config module
vi.mock('../config/index.js', () => ({
  Config: {
    getTransportConfig: vi.fn(() => ({
      http: {
        execution: { port: 3001, host: 'localhost' },
        communication: {
          callbackHost: 'localhost',
          callbackPort: 3002,
          executionUrl: 'http://localhost:3001',
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
    it('should parse prompt mode', () => {
      const args = ['--prompt', 'hello world'];
      const result = parseGlobalArgs(args);

      expect(result.promptMode).toBe(true);
      expect(result.promptArgs).toEqual(args);
      expect(result.mode).toBeNull();
    });

    it('should parse start command with comm mode', () => {
      const args = ['start', '--mode', 'comm'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('comm');
      expect(result.promptMode).toBe(false);
    });

    it('should parse start command with exec mode', () => {
      const args = ['start', '--mode', 'exec'];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('exec');
      expect(result.promptMode).toBe(false);
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
      const args = ['start', '--mode', 'comm', '--port', '4000'];
      const result = parseGlobalArgs(args);

      expect(result.port).toBe(4000);
    });

    it('should parse host argument', () => {
      const args = ['start', '--mode', 'comm', '--host', '127.0.0.1'];
      const result = parseGlobalArgs(args);

      expect(result.host).toBe('127.0.0.1');
    });

    it('should parse communication-url argument', () => {
      const args = ['start', '--mode', 'exec', '--communication-url', 'http://example.com:3001'];
      const result = parseGlobalArgs(args);

      expect(result.communicationUrl).toBe('http://example.com:3001');
    });

    it('should parse feishu-chat-id argument', () => {
      const args = ['--prompt', 'test', '--feishu-chat-id', 'oc_test'];
      const result = parseGlobalArgs(args);

      expect(result.feishuChatId).toBe('oc_test');
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
      expect(result.communicationUrl).toBe('http://localhost:3001');
    });

    it('should handle multiple arguments', () => {
      const args = [
        'start',
        '--mode', 'comm',
        '--port', '5000',
        '--host', '0.0.0.0',
        '--auth-token', 'secret',
      ];
      const result = parseGlobalArgs(args);

      expect(result.mode).toBe('comm');
      expect(result.port).toBe(5000);
      expect(result.host).toBe('0.0.0.0');
      expect(result.authToken).toBe('secret');
    });
  });

  describe('getCommNodeConfig', () => {
    it('should extract comm node config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: 'comm',
        promptMode: false,
        promptArgs: [],
        port: 3001,
        host: 'localhost',
        communicationUrl: 'http://localhost:3001',
        authToken: 'test-token',
      };

      const config = getCommNodeConfig(globalArgs);

      expect(config.port).toBe(3001);
      expect(config.host).toBe('localhost');
      expect(config.callbackPort).toBe(3002);
      expect(config.authToken).toBe('test-token');
    });
  });

  describe('getExecNodeConfig', () => {
    it('should extract exec node config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: 'exec',
        promptMode: false,
        promptArgs: [],
        port: 3001,
        host: 'localhost',
        communicationUrl: 'http://example.com:3001',
        authToken: 'test-token',
      };

      const config = getExecNodeConfig(globalArgs);

      expect(config.communicationUrl).toBe('http://example.com:3001');
      expect(config.port).toBe(3001);
      expect(config.authToken).toBe('test-token');
    });
  });

  describe('getCliModeConfig', () => {
    it('should return null when not in prompt mode', () => {
      const globalArgs: GlobalArgs = {
        mode: null,
        promptMode: false,
        promptArgs: [],
        port: 3001,
        host: 'localhost',
        communicationUrl: 'http://localhost:3001',
      };

      const config = getCliModeConfig(globalArgs);

      expect(config).toBeNull();
    });

    it('should extract CLI mode config from global args', () => {
      const globalArgs: GlobalArgs = {
        mode: null,
        promptMode: true,
        promptArgs: ['--prompt', 'test prompt', '--port', '4000'],
        port: 4000,
        host: 'localhost',
        communicationUrl: 'http://localhost:4000',
        feishuChatId: 'oc_test',
      };

      const config = getCliModeConfig(globalArgs);

      expect(config).not.toBeNull();
      expect(config?.prompt).toBe('test prompt');
      expect(config?.port).toBe(4000);
      expect(config?.feishuChatId).toBe('oc_test');
    });

    it('should join args as prompt when --prompt value not found', () => {
      const globalArgs: GlobalArgs = {
        mode: null,
        promptMode: true,
        promptArgs: ['hello', 'world'],
        port: 3001,
        host: 'localhost',
        communicationUrl: 'http://localhost:3001',
      };

      const config = getCliModeConfig(globalArgs);

      expect(config?.prompt).toBe('hello world');
    });

    it('should return null when prompt is empty', () => {
      const globalArgs: GlobalArgs = {
        mode: null,
        promptMode: true,
        promptArgs: ['--prompt'],
        port: 3001,
        host: 'localhost',
        communicationUrl: 'http://localhost:3001',
      };

      const config = getCliModeConfig(globalArgs);

      expect(config).toBeNull();
    });
  });
});

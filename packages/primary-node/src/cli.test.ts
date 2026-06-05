/**
 * Tests for Primary Node CLI (packages/primary-node/src/cli.ts)
 *
 * Covers parseArgs() argument parsing, resolveChannelConfigs() config resolution,
 * isPortAvailable() port checking, and waitForPortAvailable() retry logic.
 * These are the pure/utility functions exported from cli.ts for testability.
 *
 * Issue #1617: Adding meaningful test coverage for the primary-node CLI entry point.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock core dependencies used at module level by cli.ts (createLogger, etc.)
vi.mock('@disclaude/core', () => ({
  loadConfigFile: vi.fn(),
  setLoadedConfig: vi.fn(),
  applyGlobalEnv: vi.fn(),
  createDefaultRuntimeContext: vi.fn(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  initLogger: vi.fn(),
  flushLogger: vi.fn().mockResolvedValue(undefined),
  Config: {},
  createControlHandler: vi.fn(),
  ProcessLock: vi.fn(),
  ProjectManager: vi.fn(),
}));

vi.mock('./primary-node.js', () => ({
  PrimaryNode: vi.fn(),
}));

vi.mock('./primary-agent-pool.js', () => ({
  PrimaryAgentPool: vi.fn(),
}));

vi.mock('./messaging/adapters/feishu-message-builder.js', () => ({
  createFeishuMessageBuilderOptions: vi.fn(),
}));

vi.mock('./channel-lifecycle-manager.js', () => ({
  ChannelLifecycleManager: vi.fn(),
}));

vi.mock('./channels/wired-descriptors.js', () => ({
  BUILTIN_WIRED_DESCRIPTORS: [],
}));

import { parseArgs, resolveChannelConfigs, isPortAvailable, waitForPortAvailable } from './cli.js';
import type { DisclaudeConfigWithChannels } from '@disclaude/core';

// ============================================================================
// parseArgs
// ============================================================================

describe('parseArgs', () => {
  it('should default to help command when no args provided', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  it('should parse start command', () => {
    const result = parseArgs(['start']);
    expect(result.command).toBe('start');
  });

  it('should parse --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('should parse --config flag with value', () => {
    const result = parseArgs(['start', '--config', '/path/to/config.yaml']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('/path/to/config.yaml');
  });

  it('should parse -c shorthand flag with value', () => {
    const result = parseArgs(['start', '-c', '/etc/disclaude.yaml']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('/etc/disclaude.yaml');
  });

  it('should set configPath to undefined when --config has no value', () => {
    const result = parseArgs(['start', '--config']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBeUndefined();
  });

  it('should override start with --help', () => {
    const result = parseArgs(['start', '--help']);
    expect(result.command).toBe('help');
  });

  it('should handle unknown flags gracefully (ignored)', () => {
    const result = parseArgs(['start', '--unknown', 'value']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBeUndefined();
  });

  it('should parse --api-port flag with value (Issue #3857)', () => {
    const result = parseArgs(['start', '--api-port', '9200']);
    expect(result.command).toBe('start');
    expect(result.apiPort).toBe(9200);
  });

  it('should leave apiPort undefined when not specified', () => {
    const result = parseArgs(['start']);
    expect(result.apiPort).toBeUndefined();
  });

  it('should leave apiPort undefined when --api-port has no value', () => {
    const result = parseArgs(['start', '--api-port']);
    expect(result.command).toBe('start');
    expect(result.apiPort).toBeUndefined();
  });

  it('should ignore --api-port with non-numeric value', () => {
    const result = parseArgs(['start', '--api-port', 'abc']);
    expect(result.command).toBe('start');
    expect(result.apiPort).toBeUndefined();
  });

  it('should ignore --api-port with out-of-range value', () => {
    const result = parseArgs(['start', '--api-port', '99999']);
    expect(result.command).toBe('start');
    expect(result.apiPort).toBeUndefined();
  });

  it('should handle all options together', () => {
    const result = parseArgs(['start', '--config', '/my/config.yaml']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('/my/config.yaml');
  });

  it('should use last --config value when specified multiple times', () => {
    const result = parseArgs(['start', '--config', '/first.yaml', '--config', '/second.yaml']);
    expect(result.configPath).toBe('/second.yaml');
  });
});

// ============================================================================
// resolveChannelConfigs
// ============================================================================

describe('resolveChannelConfigs', () => {
  // Minimal mock of the Config singleton interface used by resolveChannelConfigs
  function createMockConfig(feishuAppId = '', feishuAppSecret = '') {
    return {
      FEISHU_APP_ID: feishuAppId,
      FEISHU_APP_SECRET: feishuAppSecret,
    };
  }

  it('should return empty array when no channels configured', () => {
    const rawConfig = {} as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should resolve REST channel when port, host, and fileStorageDir are set', () => {
    const rawConfig = {
      channels: {
        rest: { port: 3000, host: '0.0.0.0', fileStorageDir: '/tmp/files' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: 'rest',
      config: { port: 3000, host: '0.0.0.0', fileStorageDir: '/tmp/files' },
    });
  });

  it('should not resolve REST channel when port is missing', () => {
    const rawConfig = {
      channels: {
        rest: { host: '0.0.0.0', fileStorageDir: '/tmp/files' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should not resolve REST channel when host is missing', () => {
    const rawConfig = {
      channels: {
        rest: { port: 3000, fileStorageDir: '/tmp/files' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should not resolve REST channel when fileStorageDir is missing', () => {
    const rawConfig = {
      channels: {
        rest: { port: 3000, host: '0.0.0.0' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should resolve Feishu channel when appId and appSecret are set', () => {
    const rawConfig = {} as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig('cli_test_app_id', 'cli_test_app_secret');
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: 'feishu',
      config: { appId: 'cli_test_app_id', appSecret: 'cli_test_app_secret' },
    });
  });

  it('should not resolve Feishu channel when appId is empty', () => {
    const rawConfig = {} as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig('', 'cli_test_app_secret');
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should not resolve Feishu channel when appSecret is empty', () => {
    const rawConfig = {} as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig('cli_test_app_id', '');
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should resolve both REST and Feishu channels', () => {
    const rawConfig = {
      channels: {
        rest: { port: 8080, host: '127.0.0.1', fileStorageDir: '/data' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig('app_id_123', 'app_secret_456');
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('rest');
    expect(entries[1].type).toBe('feishu');
  });

  it('should warn on unrecognized channel config keys', () => {
    const rawConfig = {
      channels: {
        rest: { port: 3000, host: '0.0.0.0', fileStorageDir: '/tmp/files' },
        unknown: { someKey: 'value' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    // Should still resolve rest, but log a warning for 'unknown'
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('rest');
  });

  it('should handle empty channels object', () => {
    const rawConfig = { channels: {} } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    expect(entries).toEqual([]);
  });

  it('should handle REST config with zero port (falsy)', () => {
    const rawConfig = {
      channels: {
        rest: { port: 0, host: '0.0.0.0', fileStorageDir: '/tmp/files' },
      },
    } as DisclaudeConfigWithChannels;
    const mockConfig = createMockConfig();
    const entries = resolveChannelConfigs(rawConfig, mockConfig as never);
    // port 0 is falsy, so REST should not be resolved
    expect(entries).toEqual([]);
  });
});

// ============================================================================
// isPortAvailable
// ============================================================================

describe('isPortAvailable', () => {
  it('should return true when port is available (can be bound)', async () => {
    // Use port 0 to let the OS assign a free port, so the test server should bind
    const result = await isPortAvailable(0, '127.0.0.1');
    expect(result).toBe(true);
  });

  it('should return false when port is in use', async () => {
    // Create a server that occupies the port
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    const occupiedPort = addr.port;

    try {
      const result = await isPortAvailable(occupiedPort, '127.0.0.1');
      expect(result).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ============================================================================
// waitForPortAvailable
// ============================================================================

describe('waitForPortAvailable', () => {
  it('should return true immediately when port is available', async () => {
    const result = await waitForPortAvailable(0, '127.0.0.1', {
      maxRetries: 0,
      intervalMs: 10,
    });
    expect(result).toBe(true);
  });

  it('should return false when port is in use and retries exhausted', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    const occupiedPort = addr.port;

    try {
      const result = await waitForPortAvailable(occupiedPort, '127.0.0.1', {
        maxRetries: 2,
        intervalMs: 10,
      });
      expect(result).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('should return true after port becomes available', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    const occupiedPort = addr.port;

    // Close the server after a short delay so port becomes available
    setTimeout(() => {
      server.close();
    }, 50);

    try {
      const result = await waitForPortAvailable(occupiedPort, '127.0.0.1', {
        maxRetries: 10,
        intervalMs: 30,
      });
      expect(result).toBe(true);
    } finally {
      // Ensure server is closed
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });

  it('should use default options when not provided', async () => {
    // Just test with port 0 (available immediately) to avoid long waits
    const result = await waitForPortAvailable(0, '127.0.0.1');
    expect(result).toBe(true);
  });
});

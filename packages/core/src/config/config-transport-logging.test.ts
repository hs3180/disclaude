/**
 * Tests for Config transport, logging defaults, and debug config edge cases.
 *
 * Covers:
 * - getTransportConfig() with HTTP transport configuration
 * - getLoggingConfig() defaults when logging section is absent
 * - getDebugConfig() with specific filter fields
 * - getSessionTimeoutConfig() with partial configuration (only enabled=true)
 * - getSdkTimeoutMs() with custom value
 * - getToolConfig() with enabled/disabled arrays
 *
 * Note: Config uses module-level static readonly properties computed at import time.
 * Each test file gets its own module instance via vitest isolation.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    // HTTP transport config
    transport: {
      type: 'http',
      http: {
        execution: { host: 'localhost', port: 3000 },
        communication: { callbackHost: 'localhost', callbackPort: 3000, executionUrl: 'http://localhost:3000/api/execute' },
        authToken: 'secret-token',
      },
    },
    // No logging section — tests defaults
    // No explicit logging field at all
    agent: {
      provider: 'glm' as const,
      sdkTimeoutMs: 600_000,
    },
    glm: { apiKey: 'test-glm-key', model: 'glm-4' },
    feishu: {},
    workspace: { dir: '/test/workspace' },
    messaging: {
      debug: {
        enabled: true,
        filterForwardChatId: 'oc_test_chat_id',
        includeReasons: true,
      },
    },
    tools: {
      enabled: ['Skill', 'Bash'],
      disabled: ['WebSearch'],
      mcpServers: { test: { command: 'node' } },
    },
    sessionRestore: {
      sessionTimeout: {
        enabled: true,
        // Only enabled is set, others should use defaults
      },
    },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

// ─── HTTP Transport Configuration ──────────────────────────────────────────

describe('Config.getTransportConfig — HTTP transport', () => {
  it('should return HTTP transport config', () => {
    const transport = Config.getTransportConfig();
    expect(transport.type).toBe('http');
  });

  it('should include execution config and auth token', () => {
    const transport = Config.getTransportConfig();
    if (transport.type === 'http') {
      expect(transport.http?.execution?.host).toBe('localhost');
      expect(transport.http?.execution?.port).toBe(3000);
      expect(transport.http?.authToken).toBe('secret-token');
    }
  });

  it('should include communication config', () => {
    const transport = Config.getTransportConfig();
    if (transport.type === 'http') {
      expect(transport.http?.communication?.callbackHost).toBe('localhost');
      expect(transport.http?.communication?.callbackPort).toBe(3000);
    }
  });
});

// ─── Logging Defaults (no logging section) ─────────────────────────────────

describe('Config.getLoggingConfig — defaults when section absent', () => {
  it('should use default level "info"', () => {
    // The mock has no logging field, so defaults apply
    // But Config.LOG_LEVEL is computed at import time from fileConfigOnly.logging?.level || 'info'
    // Since our mock doesn't have logging, it should be 'info'
    // However, the static properties are computed from the mock's return value
    // Let's check through the getter
    const logging = Config.getLoggingConfig();
    // Defaults: level='info', pretty=true, rotate=false, sdkDebug=true
    expect(logging.level).toBe('info');
  });

  it('should use default pretty=true', () => {
    const logging = Config.getLoggingConfig();
    expect(logging.pretty).toBe(true);
  });

  it('should use default rotate=false', () => {
    const logging = Config.getLoggingConfig();
    expect(logging.rotate).toBe(false);
  });

  it('should use default sdkDebug=true', () => {
    const logging = Config.getLoggingConfig();
    expect(logging.sdkDebug).toBe(true);
  });
});

// ─── Debug Config with specific fields ──────────────────────────────────────

describe('Config.getDebugConfig — with specific filter fields', () => {
  it('should return enabled flag', () => {
    const debug = Config.getDebugConfig();
    expect(debug.enabled).toBe(true);
  });

  it('should return filterForwardChatId', () => {
    const debug = Config.getDebugConfig();
    expect(debug.filterForwardChatId).toBe('oc_test_chat_id');
  });

  it('should return includeReasons', () => {
    const debug = Config.getDebugConfig();
    expect(debug.includeReasons).toBe(true);
  });
});

// ─── Session Timeout with partial config ────────────────────────────────────

describe('Config.getSessionTimeoutConfig — partial configuration', () => {
  it('should use defaults for idleMinutes when only enabled is set', () => {
    const config = Config.getSessionTimeoutConfig();
    expect(config).not.toBeNull();
    expect(config?.idleMinutes).toBe(30);
  });

  it('should use defaults for maxSessions when only enabled is set', () => {
    const config = Config.getSessionTimeoutConfig();
    expect(config?.maxSessions).toBe(100);
  });

  it('should use defaults for checkIntervalMinutes when only enabled is set', () => {
    const config = Config.getSessionTimeoutConfig();
    expect(config?.checkIntervalMinutes).toBe(5);
  });

  it('should have enabled=true', () => {
    const config = Config.getSessionTimeoutConfig();
    expect(config?.enabled).toBe(true);
  });
});

// ─── SDK Timeout with custom value ──────────────────────────────────────────

describe('Config.getSdkTimeoutMs — custom value', () => {
  it('should return configured sdkTimeoutMs', () => {
    expect(Config.getSdkTimeoutMs()).toBe(600_000);
  });
});

// ─── Tool Config with enabled/disabled arrays ──────────────────────────────

describe('Config.getToolConfig — with enabled/disabled arrays', () => {
  it('should return enabled tools list', () => {
    const tools = Config.getToolConfig();
    expect(tools?.enabled).toEqual(['Skill', 'Bash']);
  });

  it('should return disabled tools list', () => {
    const tools = Config.getToolConfig();
    expect(tools?.disabled).toEqual(['WebSearch']);
  });

  it('should still return MCP servers', () => {
    const tools = Config.getToolConfig();
    expect(tools?.mcpServers?.test).toEqual({ command: 'node' });
  });
});

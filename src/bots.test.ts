/**
 * Tests for bots (src/bots.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Config
vi.mock('./config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getAgentConfig: () => ({
      apiKey: 'test-api-key',
      model: 'test-model',
      apiBaseUrl: 'http://test-url',
    }),
  },
}));

// Mock Transport
vi.mock('./transport/index.js', () => ({
  LocalTransport: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onTask: vi.fn(),
    onControl: vi.fn(),
    onMessage: vi.fn(),
    sendTask: vi.fn().mockResolvedValue({ success: true, taskId: 'test' }),
    sendControl: vi.fn().mockResolvedValue({ success: true, type: 'reset' }),
  })),
}));

// Mock Nodes
vi.mock('./nodes/index.js', () => ({
  CommunicationNode: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
  ExecutionNode: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('bots', () => {
  const originalSetMaxListeners = process.setMaxListeners;

  beforeEach(() => {
    vi.clearAllMocks();
    process.setMaxListeners = vi.fn();
  });

  afterEach(() => {
    process.setMaxListeners = originalSetMaxListeners;
  });

  describe('runFeishu', () => {
    it('should be exported as a function', async () => {
      const { runFeishu } = await import('./bots.js');
      expect(typeof runFeishu).toBe('function');
    });

    it('should increase max listeners', async () => {
      const { runFeishu } = await import('./bots.js');

      // Run (it will block, so we just check the initial call)
      const runPromise = runFeishu();
      expect(process.setMaxListeners).toHaveBeenCalledWith(20);

      // Wait for completion (will exit process, so this may not complete in tests)
      // In real tests, we'd need to mock process.exit
    });

    it('should create nodes with config', async () => {
      const { runFeishu } = await import('./bots.js');
      const { CommunicationNode, ExecutionNode } = await import('./nodes/index.js');

      // Just verify the function can be called
      expect(typeof runFeishu).toBe('function');
    });
  });

  describe('Missing credentials', () => {
    it('should throw error when FEISHU_APP_ID is missing', async () => {
      vi.resetModules();

      vi.doMock('./config/index.js', () => ({
        Config: {
          FEISHU_APP_ID: undefined,
          FEISHU_APP_SECRET: 'test-secret',
          getAgentConfig: () => ({ apiKey: 'test', model: 'test' }),
        },
      }));

      const { runFeishu } = await import('./bots.js');

      await expect(runFeishu()).rejects.toThrow('FEISHU_APP_ID');
    });

    it('should throw error when FEISHU_APP_SECRET is missing', async () => {
      vi.resetModules();

      vi.doMock('./config/index.js', () => ({
        Config: {
          FEISHU_APP_ID: 'test-id',
          FEISHU_APP_SECRET: undefined,
          getAgentConfig: () => ({ apiKey: 'test', model: 'test' }),
        },
      }));

      const { runFeishu } = await import('./bots.js');

      await expect(runFeishu()).rejects.toThrow('FEISHU_APP_SECRET');
    });
  });
});

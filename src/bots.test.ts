/**
 * Tests for bots (src/bots.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Config
vi.mock('./config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
  },
}));

// Mock FeishuBot
vi.mock('./feishu/index.js', () => ({
  FeishuBot: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
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
      const { FeishuBot } = await import('./feishu/index.js');

      // Mock start to resolve immediately
      vi.mocked(FeishuBot).mockImplementation(() => ({
        start: vi.fn().mockResolvedValue(undefined),
      }) as any);

      // Run and check
      const runPromise = runFeishu();
      expect(process.setMaxListeners).toHaveBeenCalledWith(20);
      
      // Wait for completion
      await runPromise;
    });

    it('should create FeishuBot with config', async () => {
      const { runFeishu } = await import('./bots.js');
      const { FeishuBot } = await import('./feishu/index.js');

      vi.mocked(FeishuBot).mockImplementation(() => ({
        start: vi.fn().mockResolvedValue(undefined),
      }) as any);

      await runFeishu();

      expect(FeishuBot).toHaveBeenCalledWith('test-app-id', 'test-app-secret');
    });

    it('should call bot.start()', async () => {
      const { runFeishu } = await import('./bots.js');
      const mockStart = vi.fn().mockResolvedValue(undefined);
      const { FeishuBot } = await import('./feishu/index.js');

      vi.mocked(FeishuBot).mockImplementation(() => ({
        start: mockStart,
      }) as any);

      await runFeishu();

      expect(mockStart).toHaveBeenCalled();
    });
  });

  describe('Missing credentials', () => {
    it('should throw error when FEISHU_APP_ID is missing', async () => {
      // Reset modules to get fresh imports
      vi.resetModules();

      vi.doMock('./config/index.js', () => ({
        Config: {
          FEISHU_APP_ID: undefined,
          FEISHU_APP_SECRET: 'test-secret',
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
        },
      }));

      const { runFeishu } = await import('./bots.js');

      await expect(runFeishu()).rejects.toThrow('FEISHU_APP_SECRET');
    });
  });
});

/**
 * Tests for feishu-tools-server (src/mcp/feishu-tools-server.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { send_file_to_feishu, feishuTools } from './feishu-tools-server.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

// Mock @larksuiteoapi/node-sdk
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({})),
  Domain: {
    Feishu: 'feishu.cn',
  },
}));

// Mock file-uploader
vi.mock('../feishu/file-uploader.js', () => ({
  uploadAndSendFile: vi.fn().mockResolvedValue(1024),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('feishu-tools-server', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('send_file_to_feishu', () => {
    it('should fail when chatId is not provided', async () => {
      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should fail when FEISHU_APP_ID is not set', async () => {
      delete process.env.FEISHU_APP_ID;
      process.env.FEISHU_APP_SECRET = 'test-secret';

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('FEISHU_APP_ID');
    });

    it('should fail when FEISHU_APP_SECRET is not set', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      delete process.env.FEISHU_APP_SECRET;

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('FEISHU_APP_SECRET');
    });

    it('should fail when file does not exist', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      process.env.FEISHU_APP_SECRET = 'test-secret';

      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockRejectedValue(new Error('ENOENT: no such file'));

      const result = await send_file_to_feishu({
        filePath: '/nonexistent/file.txt',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });

    it('should fail when path is a directory', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      process.env.FEISHU_APP_SECRET = 'test-secret';

      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockResolvedValue({
        isFile: () => false,
        isDirectory: () => true,
      } as import('fs').Stats);

      const result = await send_file_to_feishu({
        filePath: '/test/directory',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should succeed with valid file', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      process.env.FEISHU_APP_SECRET = 'test-secret';
      process.env.WORKSPACE_DIR = '/test/workspace';

      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        size: 2048,
      } as import('fs').Stats);

      const result = await send_file_to_feishu({
        filePath: '/test/file.txt',
        chatId: 'oc_test_chat',
      });

      expect(result.success).toBe(true);
      expect(result.fileName).toBe('file.txt');
      expect(result.message).toContain('File sent');
    });

    it('should resolve relative path using WORKSPACE_DIR', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      process.env.FEISHU_APP_SECRET = 'test-secret';
      process.env.WORKSPACE_DIR = '/test/workspace';

      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
      } as import('fs').Stats);

      await send_file_to_feishu({
        filePath: 'relative/file.txt',
        chatId: 'oc_test_chat',
      });

      expect(stat).toHaveBeenCalledWith('/test/workspace/relative/file.txt');
    });

    it('should resolve relative path using cwd when WORKSPACE_DIR not set', async () => {
      process.env.FEISHU_APP_ID = 'test-app-id';
      process.env.FEISHU_APP_SECRET = 'test-secret';
      delete process.env.WORKSPACE_DIR;

      const { stat } = await import('fs/promises');
      vi.mocked(stat).mockResolvedValue({
        isFile: () => true,
        isDirectory: () => false,
        size: 1024,
      } as import('fs').Stats);

      await send_file_to_feishu({
        filePath: 'relative/file.txt',
        chatId: 'oc_test_chat',
      });

      // Should use process.cwd()
      expect(stat).toHaveBeenCalled();
    });
  });

  describe('feishuTools export', () => {
    it('should export send_file_to_feishu tool', () => {
      expect(feishuTools.send_file_to_feishu).toBeDefined();
    });

    it('should have correct description', () => {
      expect(feishuTools.send_file_to_feishu.description).toContain('Send a file to a Feishu chat');
    });

    it('should have required parameters', () => {
      const params = feishuTools.send_file_to_feishu.parameters;
      expect(params.required).toContain('filePath');
      expect(params.required).toContain('chatId');
    });

    it('should have parameter properties', () => {
      const props = feishuTools.send_file_to_feishu.parameters.properties;
      expect(props.filePath).toBeDefined();
      expect(props.chatId).toBeDefined();
      expect(props.filePath.type).toBe('string');
      expect(props.chatId.type).toBe('string');
    });

    it('should have handler function', () => {
      expect(typeof feishuTools.send_file_to_feishu.handler).toBe('function');
    });
  });
});

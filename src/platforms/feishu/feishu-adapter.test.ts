/**
 * Tests for Feishu Platform Adapter.
 *
 * Tests the Feishu-specific implementation of IPlatformAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuPlatformAdapter } from './feishu-adapter.js';
import type { IAttachmentManager } from '../../adapters/types.js';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock FeishuMessageSender
vi.mock('./feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn().mockImplementation(() => ({
    sendText: vi.fn(),
    sendCard: vi.fn(),
    sendFile: vi.fn(),
    addReaction: vi.fn(),
  })),
}));

// Mock FeishuFileHandler
vi.mock('./feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn().mockImplementation(() => ({
    handleFileMessage: vi.fn(),
    buildUploadPrompt: vi.fn().mockReturnValue('Mock upload prompt'),
  })),
}));

// Mock @larksuiteoapi/node-sdk
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn().mockImplementation(() => ({
    im: {
      message: {
        create: vi.fn(),
      },
    },
  })),
}));

describe('FeishuPlatformAdapter', () => {
  let adapter: FeishuPlatformAdapter;
  let mockAttachmentManager: IAttachmentManager;
  let mockDownloadFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAttachmentManager = {
      hasAttachments: vi.fn().mockReturnValue(false),
      getAttachments: vi.fn().mockReturnValue([]),
      addAttachment: vi.fn(),
      clearAttachments: vi.fn(),
    };

    mockDownloadFile = vi.fn().mockResolvedValue({ success: true, filePath: '/tmp/test-file' });

    adapter = new FeishuPlatformAdapter({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      logger: mockLogger as any,
      attachmentManager: mockAttachmentManager,
      downloadFile: mockDownloadFile,
    });
  });

  describe('Properties', () => {
    it('should have correct platformId', () => {
      expect(adapter.platformId).toBe('feishu');
    });

    it('should have correct platformName', () => {
      expect(adapter.platformName).toBe('Feishu/Lark');
    });

    it('should have messageSender', () => {
      expect(adapter.messageSender).toBeDefined();
    });

    it('should have fileHandler', () => {
      expect(adapter.fileHandler).toBeDefined();
    });
  });

  describe('getClient()', () => {
    it('should return the lark client', () => {
      const client = adapter.getClient();
      expect(client).toBeDefined();
    });
  });

  describe('File Handler Integration', () => {
    it('should have buildUploadPrompt method', () => {
      expect(adapter.fileHandler.buildUploadPrompt).toBeDefined();
    });

    it('should call buildUploadPrompt with correct params', () => {
      const attachment = {
        fileKey: 'test-key',
        fileName: 'test.txt',
        fileType: 'file' as const,
      };

      const result = adapter.fileHandler.buildUploadPrompt(attachment);
      expect(result).toBe('Mock upload prompt');
    });
  });
});

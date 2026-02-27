/**
 * Tests for Platform Adapter Factory.
 *
 * Tests the factory for creating platform-specific adapters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlatformAdapterFactory, createPlatformAdapterFactory } from './factory.js';
import type { IPlatformAdapter, IMessageSender, IAttachmentManager } from './types.js';

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
};

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock Feishu platform adapter
vi.mock('../../../platforms/feishu/index.js', () => ({
  FeishuPlatformAdapter: vi.fn().mockImplementation((config) => ({
    platformId: 'feishu',
    platformName: 'Feishu/Lark',
    messageSender: {
      sendText: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
      addReaction: vi.fn(),
    },
    fileHandler: {
      handleFileMessage: vi.fn(),
      buildUploadPrompt: vi.fn(),
    },
    config,
  })),
}));

// Mock REST platform adapter
vi.mock('../../../platforms/rest/index.js', () => ({
  RestPlatformAdapter: vi.fn().mockImplementation((config) => ({
    platformId: 'rest',
    platformName: 'REST API',
    messageSender: {
      sendText: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    },
    fileHandler: undefined,
    config,
  })),
}));

describe('PlatformAdapterFactory', () => {
  let factory: PlatformAdapterFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    factory = new PlatformAdapterFactory(mockLogger as any);
  });

  describe('Built-in Platforms', () => {
    it('should support feishu platform', () => {
      expect(factory.isSupported('feishu')).toBe(true);
    });

    it('should support rest platform', () => {
      expect(factory.isSupported('rest')).toBe(true);
    });

    it('should return all supported types', () => {
      const types = factory.getSupportedTypes();
      expect(types).toContain('feishu');
      expect(types).toContain('rest');
    });
  });

  describe('create()', () => {
    it('should create Feishu adapter with valid config', () => {
      const mockAttachmentManager: IAttachmentManager = {
        hasAttachments: vi.fn(),
        getAttachments: vi.fn().mockReturnValue([]),
        addAttachment: vi.fn(),
        clearAttachments: vi.fn(),
      };

      const adapter = factory.create({
        type: 'feishu',
        appId: 'test-app-id',
        appSecret: 'test-app-secret',
        logger: mockLogger as any,
        attachmentManager: mockAttachmentManager,
        downloadFile: vi.fn(),
      });

      expect(adapter.platformId).toBe('feishu');
      expect(adapter.platformName).toBe('Feishu/Lark');
      expect(adapter.messageSender).toBeDefined();
      expect(adapter.fileHandler).toBeDefined();
    });

    it('should create REST adapter with valid config', () => {
      const adapter = factory.create({
        type: 'rest',
        baseUrl: 'http://localhost:3000',
        apiKey: 'test-api-key',
        logger: mockLogger as any,
      });

      expect(adapter.platformId).toBe('rest');
      expect(adapter.platformName).toBe('REST API');
      expect(adapter.messageSender).toBeDefined();
      expect(adapter.fileHandler).toBeUndefined();
    });

    it('should throw error for unsupported platform type', () => {
      expect(() => {
        factory.create({
          type: 'unsupported',
        } as any);
      }).toThrow('Unsupported platform type: unsupported');
    });

    it('should include supported types in error message', () => {
      try {
        factory.create({ type: 'invalid' } as any);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain('Supported types:');
        expect(message).toContain('feishu');
        expect(message).toContain('rest');
      }
    });
  });

  describe('register()', () => {
    it('should register custom platform factory', () => {
      const customAdapter: IPlatformAdapter = {
        platformId: 'custom',
        platformName: 'Custom Platform',
        messageSender: {} as IMessageSender,
      };

      factory.register('custom', () => customAdapter);

      expect(factory.isSupported('custom')).toBe(true);
      expect(factory.getSupportedTypes()).toContain('custom');
    });

    it('should create adapter using custom factory', () => {
      const customAdapter: IPlatformAdapter = {
        platformId: 'custom',
        platformName: 'Custom Platform',
        messageSender: {} as IMessageSender,
      };

      factory.register('custom', () => customAdapter);

      const adapter = factory.create({ type: 'custom' } as any);
      expect(adapter).toBe(customAdapter);
    });

    it('should warn when overwriting existing factory', () => {
      factory.register('test', () => ({} as IPlatformAdapter));
      vi.clearAllMocks();

      factory.register('test', () => ({} as IPlatformAdapter));

      expect(mockLogger.warn).toHaveBeenCalledWith(
        { type: 'test' },
        'Overwriting existing platform factory'
      );
    });
  });
});

describe('createPlatformAdapterFactory', () => {
  it('should create a factory instance', () => {
    const factory = createPlatformAdapterFactory(mockLogger as any);
    expect(factory).toBeInstanceOf(PlatformAdapterFactory);
  });
});

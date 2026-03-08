/**
 * Tests for Feishu MCP Server (stdio implementation)
 *
 * Tests the following functionality:
 * - MCP protocol initialization
 * - Tool list response
 * - Tool call handling (send_message, send_file)
 * - Error handling
 *
 * Note: This tests the server behavior indirectly through the exported
 * tool functions. The stdio communication layer is integration-tested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises before importing
const mockFsStat = vi.fn();
vi.mock('fs/promises', () => ({
  stat: mockFsStat,
}));

// Mock the lark SDK
const mockClient = {
  im: {
    message: {
      create: vi.fn(),
      reply: vi.fn(),
    },
  },
};

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => mockClient),
  Domain: {
    Feishu: 'https://open.feishu.cn',
  },
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock feishu-uploader
vi.mock('../file-transfer/outbound/feishu-uploader.js', () => ({
  uploadAndSendFile: vi.fn(),
}));

describe('Feishu MCP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tool Definitions', () => {
    it('should define send_message tool with correct schema', async () => {
      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendMessageTool = feishuToolDefinitions.find(t => t.name === 'send_message');
      expect(sendMessageTool).toBeDefined();

      // Issue #1155: Consolidated tool description
      // Verify description mentions key modes
      expect(sendMessageTool?.description).toContain('Send a message');
      expect(sendMessageTool?.description).toContain('Text');
      expect(sendMessageTool?.description).toContain('Card');
      expect(sendMessageTool?.description).toContain('Interactive');
      expect(sendMessageTool?.description).toContain('Question');
    });

    it('should define send_file tool with correct schema', async () => {
      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendFileTool = feishuToolDefinitions.find(t => t.name === 'send_file');
      expect(sendFileTool).toBeDefined();
      expect(sendFileTool?.description).toContain('Send a file');
    });

    // Issue #1155: Verify consolidated tool count (9 -> 4 tools)
    it('should have exactly 3 consolidated tools', async () => {
      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      expect(feishuToolDefinitions.length).toBe(3);
      expect(feishuToolDefinitions.map(t => t.name)).toEqual(
        expect.arrayContaining(['send_message', 'send_file', 'create_study_guide'])
      );
    });
  });

  describe('MCP Server Factory', () => {
    it('should create MCP server instance', async () => {
      const { createFeishuSdkMcpServer } = await import('./feishu-context-mcp.js');

      const server = createFeishuSdkMcpServer();

      expect(server).toBeDefined();
    });
  });

  describe('Tool Execution via SDK Tools', () => {
    it('should execute send_message through SDK tool wrapper', async () => {
      mockClient.im.message.create.mockResolvedValueOnce({});

      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendMessageTool = feishuToolDefinitions.find(t => t.name === 'send_message');
      expect(sendMessageTool).toBeDefined();

      // Execute the tool handler
      const result = await sendMessageTool?.handler({
        content: 'Test message',
        format: 'text',
        chatId: 'chat-123',
      });

      // Verify result format (SDK tool returns content array)
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result?.content)).toBe(true);
      expect(result?.content[0]).toHaveProperty('type', 'text');
    });

    it('should execute send_file through SDK tool wrapper', async () => {
      const { uploadAndSendFile } = await import('../file-transfer/outbound/feishu-uploader.js');
      vi.mocked(uploadAndSendFile).mockResolvedValueOnce(1024);
      mockFsStat.mockResolvedValue({ isFile: () => true, size: 1024 });

      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendFileTool = feishuToolDefinitions.find(t => t.name === 'send_file');
      expect(sendFileTool).toBeDefined();

      // Execute the tool handler
      const result = await sendFileTool?.handler({
        filePath: '/test/file.txt',
        chatId: 'chat-123',
      });

      // Verify result format
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result?.content)).toBe(true);
    });

    it('should handle tool errors gracefully (soft error)', async () => {
      mockClient.im.message.create.mockRejectedValueOnce(new Error('API Error'));

      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendMessageTool = feishuToolDefinitions.find(t => t.name === 'send_message');

      // Execute the tool handler - should return soft error, not throw
      const result = await sendMessageTool?.handler({
        content: 'Test message',
        format: 'text',
        chatId: 'chat-123',
      });

      // Should return soft error message
      expect(result).toHaveProperty('content');
      expect(result?.content[0]?.text).toContain('⚠️');
    });
  });

  describe('JSON-RPC Message Format', () => {
    it('should return proper JSON-RPC 2.0 response format', async () => {
      mockClient.im.message.create.mockResolvedValueOnce({});

      const { feishuToolDefinitions } = await import('./feishu-context-mcp.js');

      const sendMessageTool = feishuToolDefinitions.find(t => t.name === 'send_message');

      const result = await sendMessageTool?.handler({
        content: 'Test',
        format: 'text',
        chatId: 'chat-123',
      });

      // MCP CallToolResult format
      expect(result).toEqual({
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.any(String),
          }),
        ]),
      });
    });
  });
});

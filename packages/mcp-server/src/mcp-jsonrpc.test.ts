/**
 * Tests for MCP JSON-RPC handling logic.
 *
 * Issue #1617 Phase 3: MCP Server coverage improvement.
 * Tests the shared JSON-RPC request handler and tool call dispatch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool implementations
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
  send_file: vi.fn(),
}));

import { handleJsonRpc, handleToolCall, toolSuccess, toolError, TOOLS } from './mcp-jsonrpc.js';
import { send_text, send_card, send_interactive_message, send_file } from './index.js';

describe('TOOLS definition', () => {
  it('should define exactly 4 tools', () => {
    expect(TOOLS).toHaveLength(4);
  });

  it('should have correct tool names', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toContain('send_text');
    expect(names).toContain('send_card');
    expect(names).toContain('send_interactive');
    expect(names).toContain('send_file');
  });

  it('should have inputSchema for each tool', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it('should require text and chatId for send_text', () => {
    const sendTextTool = TOOLS.find(t => t.name === 'send_text')!;
    expect(sendTextTool.inputSchema.required).toEqual(['text', 'chatId']);
  });

  it('should require card and chatId for send_card', () => {
    const sendCardTool = TOOLS.find(t => t.name === 'send_card')!;
    expect(sendCardTool.inputSchema.required).toEqual(['card', 'chatId']);
  });

  it('should require question, options, and chatId for send_interactive', () => {
    const sendInteractiveTool = TOOLS.find(t => t.name === 'send_interactive')!;
    expect(sendInteractiveTool.inputSchema.required).toEqual(['question', 'options', 'chatId']);
  });

  it('should require filePath and chatId for send_file', () => {
    const sendFileTool = TOOLS.find(t => t.name === 'send_file')!;
    expect(sendFileTool.inputSchema.required).toEqual(['filePath', 'chatId']);
  });
});

describe('toolSuccess', () => {
  it('should return content with text type', () => {
    const result = toolSuccess('Operation successful');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Operation successful' }],
    });
  });

  it('should not have isError field', () => {
    const result = toolSuccess('OK');
    expect('isError' in result).toBe(false);
  });
});

describe('toolError', () => {
  it('should return content with text type and isError true', () => {
    const result = toolError('Something failed');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Something failed' }],
      isError: true,
    });
  });
});

describe('handleToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('send_text', () => {
    it('should return error when text is not a string', async () => {
      const result = await handleToolCall('send_text', { text: 123, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_text', { text: 'Hello' });
      expect(result.isError).toBe(true);
    });

    it('should return error when chatId is not a string', async () => {
      const result = await handleToolCall('send_text', { text: 'Hello', chatId: 123 });
      expect(result.isError).toBe(true);
    });

    it('should call send_text and return success result', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: '✅ Text message sent' });
      const result = await handleToolCall('send_text', { text: 'Hello', chatId: 'oc_test' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('✅ Text message sent');
    });

    it('should call send_text and return error result', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: false, message: '❌ Failed' });
      const result = await handleToolCall('send_text', { text: 'Hello', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('❌ Failed');
    });

    it('should pass parentMessageId and mentions to send_text', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: '✅ Sent' });
      await handleToolCall('send_text', {
        text: 'Hello',
        chatId: 'oc_test',
        parentMessageId: 'parent_123',
        mentions: [{ openId: 'ou_123', name: 'User' }],
      });
      expect(send_text).toHaveBeenCalledWith({
        text: 'Hello',
        chatId: 'oc_test',
        parentMessageId: 'parent_123',
        mentions: [{ openId: 'ou_123', name: 'User' }],
      });
    });
  });

  describe('send_card', () => {
    const validCard = {
      config: { wide_screen_mode: true },
      header: { title: { content: 'Test', tag: 'plain_text' } },
      elements: [{ tag: 'markdown', content: 'Hello' }],
    };

    it('should return error when card is missing', async () => {
      const result = await handleToolCall('send_card', { chatId: 'oc_test' });
      expect(result.isError).toBe(true);
    });

    it('should return error when card is an array', async () => {
      const result = await handleToolCall('send_card', { card: [1, 2, 3], chatId: 'oc_test' });
      expect(result.isError).toBe(true);
    });

    it('should return error when card is a string', async () => {
      const result = await handleToolCall('send_card', { card: 'not an object', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_card', { card: validCard });
      expect(result.isError).toBe(true);
    });

    it('should return error for invalid card structure', async () => {
      const result = await handleToolCall('send_card', {
        card: { config: {} },
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card structure');
    });

    it('should call send_card and return success for valid card', async () => {
      vi.mocked(send_card).mockResolvedValue({ success: true, message: '✅ Card message sent' });
      const result = await handleToolCall('send_card', { card: validCard, chatId: 'oc_test' });
      expect(result.isError).toBeUndefined();
      expect(send_card).toHaveBeenCalledWith({
        card: validCard,
        chatId: 'oc_test',
        parentMessageId: undefined,
      });
    });
  });

  describe('send_interactive', () => {
    it('should return error when question is not a string', async () => {
      const result = await handleToolCall('send_interactive', {
        question: 123, options: [{ text: 'A', value: 'a' }], chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
    });

    it('should return error when options is not an array', async () => {
      const result = await handleToolCall('send_interactive', {
        question: 'Q?', options: 'not-array', chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
    });

    it('should return error when options is empty', async () => {
      const result = await handleToolCall('send_interactive', {
        question: 'Q?', options: [], chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_interactive', {
        question: 'Q?', options: [{ text: 'A', value: 'a' }],
      });
      expect(result.isError).toBe(true);
    });

    it('should call send_interactive_message with correct params', async () => {
      vi.mocked(send_interactive_message).mockResolvedValue({
        success: true, message: '✅ Interactive message sent with 2 action(s)',
      });
      const result = await handleToolCall('send_interactive', {
        question: 'Which?',
        options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b', type: 'primary' }],
        chatId: 'oc_test',
        title: 'Test Title',
        context: 'Some context',
      });
      expect(result.isError).toBeUndefined();
      expect(send_interactive_message).toHaveBeenCalledWith({
        question: 'Which?',
        options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b', type: 'primary' }],
        chatId: 'oc_test',
        title: 'Test Title',
        context: 'Some context',
        actionPrompts: undefined,
        parentMessageId: undefined,
      });
    });
  });

  describe('send_file', () => {
    it('should return error when filePath is not a string', async () => {
      const result = await handleToolCall('send_file', { filePath: 123, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_file', { filePath: '/tmp/test.txt' });
      expect(result.isError).toBe(true);
    });

    it('should call send_file and prefix with "File sent:" on success', async () => {
      vi.mocked(send_file).mockResolvedValue({
        success: true,
        message: '✅ File sent: test.txt (0.01 MB)',
        fileName: 'test.txt',
        fileSize: 10240,
      });
      const result = await handleToolCall('send_file', {
        filePath: '/tmp/test.txt',
        chatId: 'oc_test',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('File sent:');
    });

    it('should return error when send_file fails', async () => {
      vi.mocked(send_file).mockResolvedValue({
        success: false,
        message: '❌ File upload requires IPC',
      });
      const result = await handleToolCall('send_file', {
        filePath: '/tmp/test.txt',
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const result = await handleToolCall('unknown_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });
  });
});

describe('handleJsonRpc', () => {
  let sentResponses: unknown[];

  beforeEach(() => {
    sentResponses = [];
    vi.clearAllMocks();
  });

  function createSendResponse() {
    return (response: unknown) => {
      sentResponses.push(response);
    };
  }

  describe('initialize', () => {
    it('should respond with server capabilities', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      expect(sentResponses[0]).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'channel-mcp', version: '0.0.1' },
        },
      });
    });
  });

  describe('notifications/initialized', () => {
    it('should not send any response for notification', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(0);
    });
  });

  describe('tools/list', () => {
    it('should respond with tool definitions', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      expect(sentResponses[0]).toEqual({
        jsonrpc: '2.0',
        id: 2,
        result: { tools: TOOLS },
      });
    });
  });

  describe('tools/call', () => {
    it('should dispatch to handleToolCall and return result', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: '✅ Sent' });
      await handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'send_text', arguments: { text: 'Hello', chatId: 'oc_test' } },
        },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      const response = sentResponses[0] as any;
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(3);
      expect(response.result).toBeDefined();
    });
  });

  describe('ping', () => {
    it('should respond with empty result', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 4, method: 'ping' },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      expect(sentResponses[0]).toEqual({
        jsonrpc: '2.0',
        id: 4,
        result: {},
      });
    });
  });

  describe('unknown method', () => {
    it('should respond with method not found error', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 5, method: 'unknown/method' },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      const response = sentResponses[0] as any;
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('Method not found');
    });
  });

  describe('error handling', () => {
    it('should catch tool execution errors and return internal error', async () => {
      vi.mocked(send_text).mockRejectedValue(new Error('Internal failure'));
      await handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: { name: 'send_text', arguments: { text: 'Hello', chatId: 'oc_test' } },
        },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      const response = sentResponses[0] as any;
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('Internal failure');
    });

    it('should handle non-Error throws', async () => {
      vi.mocked(send_text).mockRejectedValue('string error');
      await handleJsonRpc(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'send_text', arguments: { text: 'Hello', chatId: 'oc_test' } },
        },
        createSendResponse(),
      );
      expect(sentResponses).toHaveLength(1);
      const response = sentResponses[0] as any;
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe('Internal error');
    });
  });

  describe('request without params', () => {
    it('should handle tools/call without params gracefully', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 8, method: 'tools/call' },
        createSendResponse(),
      );
      // Should not crash - unknown tool
      expect(sentResponses).toHaveLength(1);
      const response = sentResponses[0] as any;
      expect(response.result.isError).toBe(true);
    });
  });
});

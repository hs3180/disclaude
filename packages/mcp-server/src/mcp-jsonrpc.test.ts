/**
 * Tests for MCP JSON-RPC handling logic (mcp-jsonrpc.ts)
 *
 * Covers:
 * - TOOLS definition structure
 * - toolSuccess / toolError response helpers
 * - handleToolCall: validation + dispatch for each tool
 * - handleJsonRpc: initialize, tools/list, tools/call, ping, unknown method, errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all tool implementations — mcp-jsonrpc.ts imports from ./index.js
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
  send_interactive: vi.fn(),
  send_file: vi.fn(),
}));

vi.mock('./utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn().mockReturnValue(true),
  getCardValidationError: vi.fn().mockReturnValue('invalid card structure'),
}));

import {
  TOOLS,
  toolSuccess,
  toolError,
  handleToolCall,
  handleJsonRpc,
} from './mcp-jsonrpc.js';
import {
  send_text,
  send_card,
  send_interactive_message,
  send_file,
} from './index.js';
import { isValidFeishuCard } from './utils/card-validator.js';

const mock_send_text = vi.mocked(send_text);
const mock_send_card = vi.mocked(send_card);
const mock_send_interactive = vi.mocked(send_interactive_message);
const mock_send_file = vi.mocked(send_file);
const mock_isValidFeishuCard = vi.mocked(isValidFeishuCard);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset card validator mock to default (valid card)
  mock_isValidFeishuCard.mockReturnValue(true);
});

// ============================================================================
// TOOLS definition
// ============================================================================
describe('TOOLS', () => {
  it('should define exactly 4 tools', () => {
    expect(TOOLS).toHaveLength(4);
  });

  it('should include send_text, send_card, send_interactive, send_file', () => {
    const names = TOOLS.map(t => t.name);
    expect(names).toContain('send_text');
    expect(names).toContain('send_card');
    expect(names).toContain('send_interactive');
    expect(names).toContain('send_file');
  });

  it('each tool should have name, description, and inputSchema', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.inputSchema.required).toBeDefined();
    }
  });
});

// ============================================================================
// toolSuccess / toolError
// ============================================================================
describe('toolSuccess', () => {
  it('should return content with type text', () => {
    const result = toolSuccess('ok');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
  });
});

describe('toolError', () => {
  it('should return content with isError true', () => {
    const result = toolError('fail');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'fail' }],
      isError: true,
    });
  });
});

// ============================================================================
// handleToolCall
// ============================================================================
describe('handleToolCall', () => {
  describe('send_text', () => {
    it('should return error when text is not a string', async () => {
      const result = await handleToolCall('send_text', { text: 123, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid text');
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_text', { text: 'hello' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return error when chatId is not a string', async () => {
      const result = await handleToolCall('send_text', { text: 'hello', chatId: 123 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return success when send_text succeeds', async () => {
      mock_send_text.mockResolvedValue({ success: true, message: 'sent' });
      const result = await handleToolCall('send_text', { text: 'hello', chatId: 'oc_test' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('sent');
    });

    it('should return error when send_text fails', async () => {
      mock_send_text.mockResolvedValue({ success: false, message: 'failed' });
      const result = await handleToolCall('send_text', { text: 'hello', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('failed');
    });

    it('should pass parentMessageId and mentions to send_text', async () => {
      mock_send_text.mockResolvedValue({ success: true, message: 'ok' });
      await handleToolCall('send_text', {
        text: 'hello',
        chatId: 'oc_test',
        parentMessageId: 'msg_123',
        mentions: [{ openId: 'ou_abc', name: 'John' }],
      });
      expect(mock_send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: 'oc_test',
        parentMessageId: 'msg_123',
        mentions: [{ openId: 'ou_abc', name: 'John' }],
      });
    });
  });

  describe('send_card', () => {
    it('should return error when card is missing', async () => {
      const result = await handleToolCall('send_card', { chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when card is an array', async () => {
      const result = await handleToolCall('send_card', { card: [], chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when card is a string', async () => {
      const result = await handleToolCall('send_card', { card: 'not-an-object', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_card', { card: {} });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return error when card fails validation', async () => {
      mock_isValidFeishuCard.mockReturnValue(false);
      const result = await handleToolCall('send_card', { card: { foo: 'bar' }, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card structure');
    });

    it('should return success when send_card succeeds', async () => {
      mock_send_card.mockResolvedValue({ success: true, message: 'Card sent' });
      const result = await handleToolCall('send_card', { card: { header: {}, elements: [] }, chatId: 'oc_test' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Card sent');
    });

    it('should return error when send_card fails', async () => {
      mock_send_card.mockResolvedValue({ success: false, message: 'Card error' });
      const result = await handleToolCall('send_card', { card: { header: {}, elements: [] }, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Card error');
    });
  });

  describe('send_interactive', () => {
    it('should return error when question is missing', async () => {
      const result = await handleToolCall('send_interactive', { options: [{ text: 'a', value: 'b' }], chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should return error when question is not a string', async () => {
      const result = await handleToolCall('send_interactive', { question: 123, options: [{ text: 'a', value: 'b' }], chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should return error when options is not an array', async () => {
      const result = await handleToolCall('send_interactive', { question: 'Q?', options: 'bad', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should return error when options is empty', async () => {
      const result = await handleToolCall('send_interactive', { question: 'Q?', options: [], chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_interactive', { question: 'Q?', options: [{ text: 'a', value: 'b' }] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return success when send_interactive_message succeeds', async () => {
      mock_send_interactive.mockResolvedValue({ success: true, message: 'Interactive sent' });
      const result = await handleToolCall('send_interactive', {
        question: 'Q?',
        options: [{ text: 'Yes', value: 'yes' }],
        chatId: 'oc_test',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Interactive sent');
    });

    it('should pass optional fields to send_interactive_message', async () => {
      mock_send_interactive.mockResolvedValue({ success: true, message: 'ok' });
      await handleToolCall('send_interactive', {
        question: 'Q?',
        options: [{ text: 'Yes', value: 'yes', type: 'primary' }],
        chatId: 'oc_test',
        title: 'Title',
        context: 'ctx',
        actionPrompts: { yes: 'User chose yes' },
        parentMessageId: 'msg_1',
      });
      expect(mock_send_interactive).toHaveBeenCalledWith({
        question: 'Q?',
        options: [{ text: 'Yes', value: 'yes', type: 'primary' }],
        chatId: 'oc_test',
        title: 'Title',
        context: 'ctx',
        actionPrompts: { yes: 'User chose yes' },
        parentMessageId: 'msg_1',
      });
    });
  });

  describe('send_file', () => {
    it('should return error when filePath is not a string', async () => {
      const result = await handleToolCall('send_file', { filePath: 123, chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid filePath');
    });

    it('should return error when chatId is missing', async () => {
      const result = await handleToolCall('send_file', { filePath: '/tmp/test.txt' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return success when send_file succeeds', async () => {
      mock_send_file.mockResolvedValue({ success: true, message: 'file.png' });
      const result = await handleToolCall('send_file', { filePath: '/tmp/test.txt', chatId: 'oc_test' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('File sent');
      expect(result.content[0].text).toContain('file.png');
    });

    it('should return error when send_file fails', async () => {
      mock_send_file.mockResolvedValue({ success: false, message: 'not found' });
      const result = await handleToolCall('send_file', { filePath: '/tmp/test.txt', chatId: 'oc_test' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('not found');
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

// ============================================================================
// handleJsonRpc
// ============================================================================
describe('handleJsonRpc', () => {
  let responses: unknown[];

  const sendResponse = (response: unknown) => {
    responses.push(response);
  };

  beforeEach(() => {
    responses = [];
  });

  describe('initialize', () => {
    it('should respond with server capabilities', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]).toEqual({
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
    it('should not send a response for notifications', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        sendResponse,
      );
      expect(responses).toHaveLength(0);
    });
  });

  describe('tools/list', () => {
    it('should respond with tool definitions', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.result.tools).toEqual(TOOLS);
    });
  });

  describe('tools/call', () => {
    it('should dispatch to handleToolCall and return result', async () => {
      mock_send_text.mockResolvedValue({ success: true, message: 'ok' });
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } } },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.result.content[0].text).toBe('ok');
      expect(resp.result.isError).toBeUndefined();
    });

    it('should handle missing params gracefully', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 4, method: 'tools/call' },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.result.isError).toBe(true);
      expect(resp.result.content[0].text).toContain('Unknown tool');
    });
  });

  describe('ping', () => {
    it('should respond with empty result', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 5, method: 'ping' },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      expect(responses[0]).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
    });
  });

  describe('unknown method', () => {
    it('should respond with method not found error', async () => {
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 6, method: 'nonexistent' },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.error.code).toBe(-32601);
      expect(resp.error.message).toContain('Method not found');
    });
  });

  describe('error handling', () => {
    it('should catch exceptions and return internal error', async () => {
      mock_send_text.mockRejectedValue(new Error('IPC crashed'));
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } } },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.error.code).toBe(-32603);
      expect(resp.error.message).toContain('IPC crashed');
    });

    it('should handle non-Error exceptions', async () => {
      mock_send_text.mockRejectedValue('string error');
      await handleJsonRpc(
        { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } } },
        sendResponse,
      );
      expect(responses).toHaveLength(1);
      const resp = responses[0] as any;
      expect(resp.error.code).toBe(-32603);
      expect(resp.error.message).toBe('Internal error');
    });
  });
});

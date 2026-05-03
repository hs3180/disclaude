/**
 * Tests for MCP JSON-RPC handling logic (packages/mcp-server/src/mcp-jsonrpc.ts)
 *
 * Covers:
 * - TOOLS definition structure
 * - toolSuccess() / toolError() helpers
 * - handleToolCall() routing and validation
 * - handleJsonRpc() protocol handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool implementations before importing the module under test
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
  send_file: vi.fn(),
}));

import {
  TOOLS,
  toolSuccess,
  toolError,
  handleToolCall,
  handleJsonRpc,
} from './mcp-jsonrpc.js';
import { send_text, send_card, send_interactive_message, send_file } from './index.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createJsonRpcRequest(
  method: string,
  params?: unknown,
  id?: number | string | null,
) {
  return {
    jsonrpc: '2.0',
    id: id !== undefined ? id : 1,
    method,
    params,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('mcp-jsonrpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────
  // TOOLS Definition
  // ─────────────────────────────────────────
  describe('TOOLS definition', () => {
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

    it('should have required fields for each tool', () => {
      for (const tool of TOOLS) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(tool.inputSchema).toHaveProperty('type', 'object');
        expect(tool.inputSchema).toHaveProperty('properties');
        expect(tool.inputSchema).toHaveProperty('required');
      }
    });

    it('should require text and chatId for send_text', () => {
      const sendText = TOOLS.find(t => t.name === 'send_text');
      expect(sendText).toBeDefined();
      expect(sendText!.inputSchema.required).toContain('text');
      expect(sendText!.inputSchema.required).toContain('chatId');
    });

    it('should require card and chatId for send_card', () => {
      const sendCard = TOOLS.find(t => t.name === 'send_card');
      expect(sendCard).toBeDefined();
      expect(sendCard!.inputSchema.required).toContain('card');
      expect(sendCard!.inputSchema.required).toContain('chatId');
    });

    it('should require question, options, and chatId for send_interactive', () => {
      const sendInteractive = TOOLS.find(t => t.name === 'send_interactive');
      expect(sendInteractive).toBeDefined();
      expect(sendInteractive!.inputSchema.required).toContain('question');
      expect(sendInteractive!.inputSchema.required).toContain('options');
      expect(sendInteractive!.inputSchema.required).toContain('chatId');
    });

    it('should require filePath and chatId for send_file', () => {
      const sendFile = TOOLS.find(t => t.name === 'send_file');
      expect(sendFile).toBeDefined();
      expect(sendFile!.inputSchema.required).toContain('filePath');
      expect(sendFile!.inputSchema.required).toContain('chatId');
    });
  });

  // ─────────────────────────────────────────
  // toolSuccess / toolError Helpers
  // ─────────────────────────────────────────
  describe('toolSuccess', () => {
    it('should return text content without error flag', () => {
      const result = toolSuccess('Operation completed');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Operation completed' }],
      });
    });

    it('should handle empty string', () => {
      const result = toolSuccess('');
      expect(result).toEqual({
        content: [{ type: 'text', text: '' }],
      });
    });
  });

  describe('toolError', () => {
    it('should return text content with error flag', () => {
      const result = toolError('Something went wrong');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Something went wrong' }],
        isError: true,
      });
    });

    it('should handle empty string', () => {
      const result = toolError('');
      expect(result).toEqual({
        content: [{ type: 'text', text: '' }],
        isError: true,
      });
    });
  });

  // ─────────────────────────────────────────
  // handleToolCall
  // ─────────────────────────────────────────
  describe('handleToolCall', () => {
    describe('send_text', () => {
      it('should return error when text is not a string', async () => {
        const result = await handleToolCall('send_text', { text: 123, chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid text');
      });

      it('should return error when chatId is missing', async () => {
        const result = await handleToolCall('send_text', { text: 'hello' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should return error when chatId is not a string', async () => {
        const result = await handleToolCall('send_text', { text: 'hello', chatId: 123 });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should return error when chatId is empty string', async () => {
        const result = await handleToolCall('send_text', { text: 'hello', chatId: '' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should call send_text and return success', async () => {
        vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Sent' });
        const result = await handleToolCall('send_text', { text: 'hello', chatId: 'oc_test' });
        expect(send_text).toHaveBeenCalledWith({
          text: 'hello',
          chatId: 'oc_test',
          parentMessageId: undefined,
          mentions: undefined,
        });
        expect(result).toEqual({
          content: [{ type: 'text', text: 'Sent' }],
        });
      });

      it('should return error when send_text fails', async () => {
        vi.mocked(send_text).mockResolvedValue({ success: false, message: 'Failed to send' });
        const result = await handleToolCall('send_text', { text: 'hello', chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toBe('Failed to send');
      });

      it('should pass parentMessageId and mentions when provided', async () => {
        vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Sent' });
        await handleToolCall('send_text', {
          text: 'hello',
          chatId: 'oc_test',
          parentMessageId: 'msg_123',
          mentions: [{ openId: 'ou_abc', name: 'User' }],
        });
        expect(send_text).toHaveBeenCalledWith({
          text: 'hello',
          chatId: 'oc_test',
          parentMessageId: 'msg_123',
          mentions: [{ openId: 'ou_abc', name: 'User' }],
        });
      });
    });

    describe('send_card', () => {
      it('should return error when card is missing', async () => {
        const result = await handleToolCall('send_card', { chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid card');
      });

      it('should return error when card is an array', async () => {
        const result = await handleToolCall('send_card', { card: [], chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid card');
      });

      it('should return error when card is a string', async () => {
        const result = await handleToolCall('send_card', { card: 'not an object', chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid card');
      });

      it('should return error when chatId is missing', async () => {
        const result = await handleToolCall('send_card', {
          card: { config: {}, header: {}, elements: [] },
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should return error for invalid card structure', async () => {
        const result = await handleToolCall('send_card', {
          card: { invalid: true },
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid card structure');
      });

      it('should call send_card and return success for valid card', async () => {
        vi.mocked(send_card).mockResolvedValue({ success: true, message: 'Card sent' });
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'Title' } },
          elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Content' } }],
        };
        const result = await handleToolCall('send_card', { card, chatId: 'oc_test' });
        expect(send_card).toHaveBeenCalledWith({
          card,
          chatId: 'oc_test',
          parentMessageId: undefined,
        });
        expect(result).toEqual({
          content: [{ type: 'text', text: 'Card sent' }],
        });
      });

      it('should return error when send_card fails', async () => {
        vi.mocked(send_card).mockResolvedValue({ success: false, message: 'Rate limited' });
        const card = {
          config: {},
          header: { title: 'Test' },
          elements: [],
        };
        const result = await handleToolCall('send_card', { card, chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toBe('Rate limited');
      });
    });

    describe('send_interactive', () => {
      it('should return error when question is missing', async () => {
        const result = await handleToolCall('send_interactive', {
          options: [{ text: 'Yes', value: 'yes' }],
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid question');
      });

      it('should return error when question is not a string', async () => {
        const result = await handleToolCall('send_interactive', {
          question: 123,
          options: [{ text: 'Yes', value: 'yes' }],
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid question');
      });

      it('should return error when options is not an array', async () => {
        const result = await handleToolCall('send_interactive', {
          question: 'Pick one',
          options: 'not-array',
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid options');
      });

      it('should return error when options is empty array', async () => {
        const result = await handleToolCall('send_interactive', {
          question: 'Pick one',
          options: [],
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid options');
      });

      it('should return error when chatId is missing', async () => {
        const result = await handleToolCall('send_interactive', {
          question: 'Pick one',
          options: [{ text: 'Yes', value: 'yes' }],
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should call send_interactive_message and return success', async () => {
        vi.mocked(send_interactive_message).mockResolvedValue({ success: true, message: 'Interactive sent' });
        const options = [
          { text: 'Yes', value: 'yes', type: 'primary' as const },
          { text: 'No', value: 'no' },
        ];
        const result = await handleToolCall('send_interactive', {
          question: 'Continue?',
          options,
          chatId: 'oc_test',
          title: 'Confirmation',
          context: 'Please confirm',
          actionPrompts: { yes: 'User chose yes' },
          parentMessageId: 'msg_123',
        });
        expect(send_interactive_message).toHaveBeenCalledWith({
          question: 'Continue?',
          options,
          chatId: 'oc_test',
          title: 'Confirmation',
          context: 'Please confirm',
          actionPrompts: { yes: 'User chose yes' },
          parentMessageId: 'msg_123',
        });
        expect(result).toEqual({
          content: [{ type: 'text', text: 'Interactive sent' }],
        });
      });

      it('should return error when send_interactive_message fails', async () => {
        vi.mocked(send_interactive_message).mockResolvedValue({ success: false, message: 'Not allowed' });
        const result = await handleToolCall('send_interactive', {
          question: 'Pick one',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toBe('Not allowed');
      });
    });

    describe('send_file', () => {
      it('should return error when filePath is not a string', async () => {
        const result = await handleToolCall('send_file', { filePath: 123, chatId: 'oc_test' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid filePath');
      });

      it('should return error when chatId is missing', async () => {
        const result = await handleToolCall('send_file', { filePath: '/path/to/file.png' });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Invalid chatId');
      });

      it('should call send_file and return success', async () => {
        vi.mocked(send_file).mockResolvedValue({ success: true, message: 'image.png' });
        const result = await handleToolCall('send_file', {
          filePath: '/path/to/image.png',
          chatId: 'oc_test',
        });
        expect(send_file).toHaveBeenCalledWith({
          filePath: '/path/to/image.png',
          chatId: 'oc_test',
          parentMessageId: undefined,
        });
        expect(result).toEqual({
          content: [{ type: 'text', text: 'File sent: image.png' }],
        });
      });

      it('should return error when send_file fails', async () => {
        vi.mocked(send_file).mockResolvedValue({ success: false, message: 'File not found' });
        const result = await handleToolCall('send_file', {
          filePath: '/nonexistent.png',
          chatId: 'oc_test',
        });
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toBe('File not found');
      });

      it('should pass parentMessageId when provided', async () => {
        vi.mocked(send_file).mockResolvedValue({ success: true, message: 'doc.pdf' });
        await handleToolCall('send_file', {
          filePath: '/doc.pdf',
          chatId: 'oc_test',
          parentMessageId: 'msg_456',
        });
        expect(send_file).toHaveBeenCalledWith({
          filePath: '/doc.pdf',
          chatId: 'oc_test',
          parentMessageId: 'msg_456',
        });
      });
    });

    describe('unknown tool', () => {
      it('should return error for unknown tool name', async () => {
        const result = await handleToolCall('unknown_tool', {});
        expect(result).toHaveProperty('isError', true);
        expect(result.content[0].text).toContain('Unknown tool');
        expect(result.content[0].text).toContain('unknown_tool');
      });
    });
  });

  // ─────────────────────────────────────────
  // handleJsonRpc
  // ─────────────────────────────────────────
  describe('handleJsonRpc', () => {
    describe('initialize', () => {
      it('should respond with protocol version and server info', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('initialize', undefined, 42),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 42,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'channel-mcp', version: '0.0.1' },
          },
        });
      });

      it('should echo back the request id', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('initialize', undefined, 'abc'),
          (r) => { response = r; },
        );

        expect(response).toHaveProperty('id', 'abc');
      });
    });

    describe('notifications/initialized', () => {
      it('should not send any response', async () => {
        const sendResponse = vi.fn();
        await handleJsonRpc(
          createJsonRpcRequest('notifications/initialized'),
          sendResponse,
        );

        expect(sendResponse).not.toHaveBeenCalled();
      });
    });

    describe('tools/list', () => {
      it('should respond with tool definitions', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/list', undefined, 1),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 1,
          result: { tools: TOOLS },
        });
      });
    });

    describe('tools/call', () => {
      it('should handle valid tool call', async () => {
        vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Sent' });
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/call', {
            name: 'send_text',
            arguments: { text: 'hello', chatId: 'oc_test' },
          }, 1),
          (r) => { response = r; },
        );

        expect(response).toHaveProperty('jsonrpc', '2.0');
        expect(response).toHaveProperty('id', 1);
        expect(response).toHaveProperty('result');
        expect(response).not.toHaveProperty('error');
      });

      it('should handle tool call with missing params', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/call', undefined, 1),
          (r) => { response = r; },
        );

        // Empty tool name should result in error
        expect(response).toHaveProperty('result');
      });

      it('should handle tool call error', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/call', {
            name: 'send_text',
            arguments: { text: 123, chatId: 'oc_test' },
          }, 1),
          (r) => { response = r; },
        );

        expect(response).toHaveProperty('result');
        expect((response as any).result).toHaveProperty('isError', true);
      });
    });

    describe('ping', () => {
      it('should respond with empty result', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('ping', undefined, 1),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 1,
          result: {},
        });
      });
    });

    describe('unknown method', () => {
      it('should respond with method not found error', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('custom/method', undefined, 1),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32601,
            message: 'Method not found: custom/method',
          },
        });
      });
    });

    describe('error handling', () => {
      it('should catch thrown errors and return internal error', async () => {
        vi.mocked(send_text).mockRejectedValue(new Error('Network failure'));
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/call', {
            name: 'send_text',
            arguments: { text: 'hello', chatId: 'oc_test' },
          }, 1),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32603,
            message: 'Network failure',
          },
        });
      });

      it('should handle non-Error thrown values', async () => {
        vi.mocked(send_text).mockRejectedValue('string error');
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('tools/call', {
            name: 'send_text',
            arguments: { text: 'hello', chatId: 'oc_test' },
          }, 1),
          (r) => { response = r; },
        );

        expect(response).toEqual({
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32603,
            message: 'Internal error',
          },
        });
      });
    });

    describe('request id handling', () => {
      it('should support null id', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('ping', undefined, null),
          (r) => { response = r; },
        );

        expect(response).toHaveProperty('id', null);
      });

      it('should support string id', async () => {
        let response: unknown;
        await handleJsonRpc(
          createJsonRpcRequest('ping', undefined, 'request-123'),
          (r) => { response = r; },
        );

        expect(response).toHaveProperty('id', 'request-123');
      });
    });
  });
});

/**
 * Tests for MCP JSON-RPC handling logic.
 *
 * Covers:
 * - TOOLS definitions (correct schema structure)
 * - toolSuccess() / toolError() response helpers
 * - handleToolCall() — parameter validation and tool routing
 * - handleJsonRpc() — JSON-RPC method dispatch and error handling
 *
 * @module mcp-server/mcp-jsonrpc
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tool implementations before importing the module under test
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
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

/** Type for tool call results (success or error). */
type ToolCallResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};
import {
  send_text,
  send_card,
  send_interactive_message,
  send_file,
} from './index.js';

const mocked_send_text = vi.mocked(send_text);
const mocked_send_card = vi.mocked(send_card);
const mocked_send_interactive = vi.mocked(send_interactive_message);
const mocked_send_file = vi.mocked(send_file);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// TOOLS definitions
// ============================================================================
describe('TOOLS definitions', () => {
  it('should define exactly 4 tools', () => {
    expect(TOOLS).toHaveLength(4);
  });

  it('should include all expected tool names', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain('send_text');
    expect(names).toContain('send_card');
    expect(names).toContain('send_interactive');
    expect(names).toContain('send_file');
  });

  it('should have required inputSchema for each tool', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(tool.description).toBeTruthy();
    }
  });

  it('should require text and chatId for send_text', () => {
    const tool = TOOLS.find((t) => t.name === 'send_text')!;
    expect(tool.inputSchema.required).toContain('text');
    expect(tool.inputSchema.required).toContain('chatId');
  });

  it('should require card and chatId for send_card', () => {
    const tool = TOOLS.find((t) => t.name === 'send_card')!;
    expect(tool.inputSchema.required).toContain('card');
    expect(tool.inputSchema.required).toContain('chatId');
  });

  it('should require question, options, and chatId for send_interactive', () => {
    const tool = TOOLS.find((t) => t.name === 'send_interactive')!;
    expect(tool.inputSchema.required).toContain('question');
    expect(tool.inputSchema.required).toContain('options');
    expect(tool.inputSchema.required).toContain('chatId');
  });

  it('should require filePath and chatId for send_file', () => {
    const tool = TOOLS.find((t) => t.name === 'send_file')!;
    expect(tool.inputSchema.required).toContain('filePath');
    expect(tool.inputSchema.required).toContain('chatId');
  });
});

// ============================================================================
// toolSuccess / toolError
// ============================================================================
describe('toolSuccess', () => {
  it('should return a text content result without error', () => {
    const result = toolSuccess('ok');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
  });
});

describe('toolError', () => {
  it('should return a text content result with isError true', () => {
    const result = toolError('failed');
    expect(result).toEqual({
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    });
  });
});

// ============================================================================
// handleToolCall
// ============================================================================
describe('handleToolCall', () => {
  // ----- send_text -----
  describe('send_text', () => {
    it('should return error when text is not a string', async () => {
      const result: ToolCallResult = await handleToolCall('send_text', {
        text: 123,
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid text');
    });

    it('should return error when chatId is missing', async () => {
      const result: ToolCallResult = await handleToolCall('send_text', { text: 'hi' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return error when chatId is empty string', async () => {
      const result: ToolCallResult = await handleToolCall('send_text', {
        text: 'hi',
        chatId: '',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return success on valid send_text', async () => {
      mocked_send_text.mockResolvedValue({
        success: true,
        message: 'sent',
      });
      const result: ToolCallResult = await handleToolCall('send_text', {
        text: 'hello',
        chatId: 'oc_test',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('sent');
      expect(mocked_send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: 'oc_test',
        parentMessageId: undefined,
        mentions: undefined,
      });
    });

    it('should pass parentMessageId and mentions when provided', async () => {
      mocked_send_text.mockResolvedValue({
        success: true,
        message: 'sent',
      });
      await handleToolCall('send_text', {
        text: 'hi',
        chatId: 'oc_test',
        parentMessageId: 'pm_123',
        mentions: [{ openId: 'ou_abc', name: 'User' }],
      });
      expect(mocked_send_text).toHaveBeenCalledWith(
        expect.objectContaining({
          parentMessageId: 'pm_123',
          mentions: [{ openId: 'ou_abc', name: 'User' }],
        }),
      );
    });

    it('should return error when send_text fails', async () => {
      mocked_send_text.mockResolvedValue({
        success: false,
        message: 'IPC error',
      });
      const result: ToolCallResult = await handleToolCall('send_text', {
        text: 'hello',
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('IPC error');
    });
  });

  // ----- send_card -----
  describe('send_card', () => {
    it('should return error when card is null', async () => {
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: null,
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when card is an array', async () => {
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: [],
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when card is a string', async () => {
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: 'not a card',
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should return error when chatId is missing', async () => {
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: { config: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return error when card fails validation', async () => {
      const { isValidFeishuCard } = await import('./utils/card-validator.js');
      vi.mocked(isValidFeishuCard).mockReturnValue(false);
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: { bad: true },
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card structure');
    });

    it('should return success on valid card', async () => {
      const { isValidFeishuCard } = await import('./utils/card-validator.js');
      vi.mocked(isValidFeishuCard).mockReturnValue(true);
      mocked_send_card.mockResolvedValue({
        success: true,
        message: 'Card sent',
      });
      const result: ToolCallResult = await handleToolCall('send_card', {
        card: { config: {}, header: {}, elements: [] },
        chatId: 'oc_test',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Card sent');
    });
  });

  // ----- send_interactive -----
  describe('send_interactive', () => {
    it('should return error when question is empty', async () => {
      const result: ToolCallResult = await handleToolCall('send_interactive', {
        question: '',
        options: [{ text: 'A', value: 'a' }],
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should return error when question is not a string', async () => {
      const result: ToolCallResult = await handleToolCall('send_interactive', {
        question: 42,
        options: [{ text: 'A', value: 'a' }],
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should return error when options is not an array', async () => {
      const result: ToolCallResult = await handleToolCall('send_interactive', {
        question: 'Pick one',
        options: 'not-array',
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should return error when options is empty array', async () => {
      const result: ToolCallResult = await handleToolCall('send_interactive', {
        question: 'Pick one',
        options: [],
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should return error when chatId is missing', async () => {
      const result: ToolCallResult = await handleToolCall('send_interactive', {
        question: 'Pick one',
        options: [{ text: 'A', value: 'a' }],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should pass all optional fields to send_interactive_message', async () => {
      mocked_send_interactive.mockResolvedValue({
        success: true,
        message: 'Interactive sent',
      });
      await handleToolCall('send_interactive', {
        question: 'Continue?',
        options: [{ text: 'Yes', value: 'yes', type: 'primary' }],
        chatId: 'oc_test',
        title: 'Decision',
        context: 'Review context',
        actionPrompts: { yes: 'User approved' },
        parentMessageId: 'pm_1',
      });
      expect(mocked_send_interactive).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Decision',
          context: 'Review context',
          actionPrompts: { yes: 'User approved' },
          parentMessageId: 'pm_1',
        }),
      );
    });
  });

  // ----- send_file -----
  describe('send_file', () => {
    it('should return error when filePath is not a string', async () => {
      const result: ToolCallResult = await handleToolCall('send_file', {
        filePath: 42,
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid filePath');
    });

    it('should return error when chatId is missing', async () => {
      const result: ToolCallResult = await handleToolCall('send_file', {
        filePath: '/path/to/file',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should return success and prefix with "File sent:" on valid file', async () => {
      mocked_send_file.mockResolvedValue({
        success: true,
        message: 'test.pdf uploaded',
      });
      const result: ToolCallResult = await handleToolCall('send_file', {
        filePath: '/path/to/test.pdf',
        chatId: 'oc_test',
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('File sent: test.pdf uploaded');
    });

    it('should return error when send_file fails', async () => {
      mocked_send_file.mockResolvedValue({
        success: false,
        message: 'Upload failed',
      });
      const result: ToolCallResult = await handleToolCall('send_file', {
        filePath: '/path/to/file',
        chatId: 'oc_test',
      });
      expect(result.isError).toBe(true);
    });
  });

  // ----- unknown tool -----
  describe('unknown tool', () => {
    it('should return error for unknown tool name', async () => {
      const result: ToolCallResult = await handleToolCall('nonexistent_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });
  });
});

// ============================================================================
// handleJsonRpc
// ============================================================================
describe('handleJsonRpc', () => {
  it('should respond to initialize request', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.jsonrpc).toBe('2.0');
    expect(resp.id).toBe(1);
    expect(resp.result).toBeDefined();
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo).toEqual({
      name: 'channel-mcp',
      version: '0.0.1',
    });
  });

  it('should not send response for notifications/initialized', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sendResponse,
    );

    expect(sent).toHaveLength(0);
  });

  it('should respond to tools/list with tool definitions', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.result).toEqual({ tools: TOOLS });
  });

  it('should respond to ping', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 3, method: 'ping' },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.result).toEqual({});
  });

  it('should return method not found error for unknown method', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 4, method: 'custom/method' },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.error).toBeDefined();
    const error = resp.error as Record<string, unknown>;
    expect(error.code).toBe(-32601);
    expect(error.message).toContain('Method not found');
  });

  it('should handle tools/call by delegating to handleToolCall', async () => {
    mocked_send_text.mockResolvedValue({
      success: true,
      message: 'sent',
    });
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } },
      },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.result).toBeDefined();
    expect(resp.result).toHaveProperty('content');
  });

  it('should handle tools/call with missing params gracefully', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 6, method: 'tools/call' },
      sendResponse,
    );

    // handleToolCall receives '' as name, which is "unknown tool"
    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    const result = resp.result as Record<string, unknown>;
    expect(result.isError).toBe(true);
  });

  it('should return internal error when handler throws', async () => {
    mocked_send_text.mockRejectedValue(new Error('boom'));
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } },
      },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.error).toBeDefined();
    const error = resp.error as Record<string, unknown>;
    expect(error.code).toBe(-32603);
    expect(error.message).toContain('boom');
  });

  it('should handle non-Error throws in internal error', async () => {
    mocked_send_text.mockImplementation(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'string-error';
    });
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'send_text', arguments: { text: 'hi', chatId: 'oc_test' } },
      },
      sendResponse,
    );

    expect(sent).toHaveLength(1);
    const resp = sent[0] as Record<string, unknown>;
    expect(resp.error).toBeDefined();
    const error = resp.error as Record<string, unknown>;
    expect(error.message).toBe('Internal error');
  });

  it('should preserve request id in response', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: 'custom-id-42', method: 'ping' },
      sendResponse,
    );

    const resp = sent[0] as Record<string, unknown>;
    expect(resp.id).toBe('custom-id-42');
  });

  it('should handle null id in request', async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown) => sent.push(r);

    await handleJsonRpc(
      { jsonrpc: '2.0', id: null, method: 'ping' },
      sendResponse,
    );

    const resp = sent[0] as Record<string, unknown>;
    expect(resp.id).toBeNull();
  });
});

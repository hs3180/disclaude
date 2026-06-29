/**
 * Tests for MCP tool dispatch (packages/mcp-server/src/tools/tool-dispatch.ts)
 *
 * Issue #4128: Validation + dispatch logic extracted from cli.ts handleRequest().
 *
 * These tests exercise dispatchToolCall() in isolation: every tool handler
 * (send_text / send_card / send_file / send_interactive_message / push_to_agent)
 * and the card validator are mocked, so no real IPC, network, or filesystem
 * side effect is ever triggered. The dispatch/validation contract is identical
 * to what handleRequest() used to do inline before the refactor.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the tool implementations — the dispatch boundary. No IPC/network effects.
vi.mock('./index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_file: vi.fn(),
  send_interactive_message: vi.fn(),
  push_to_agent: vi.fn(),
}));

vi.mock('../utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn(),
  getCardValidationError: vi.fn((_card: unknown) => 'missing config/header/elements'),
}));

// Import after mocks are set up
import { dispatchToolCall } from './tool-dispatch.js';
import {
  send_text,
  send_card,
  send_file,
  send_interactive_message,
  push_to_agent,
} from './index.js';
import { isValidFeishuCard } from '../utils/card-validator.js';

const VALID_CHAT_ID = 'oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

type ToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

describe('dispatchToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('send_text', () => {
    it('rejects non-string text', async () => {
      const result = await dispatchToolCall('send_text', { text: 123, chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid text');
      expect(send_text).not.toHaveBeenCalled();
    });

    it('rejects missing chatId', async () => {
      const result = await dispatchToolCall('send_text', { text: 'hello' }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
      expect(send_text).not.toHaveBeenCalled();
    });

    it('rejects non-string chatId', async () => {
      const result = await dispatchToolCall('send_text', { text: 'hello', chatId: 42 }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
      expect(send_text).not.toHaveBeenCalled();
    });

    it('calls send_text on valid input and returns success', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Message sent' });
      const result = await dispatchToolCall('send_text', { text: 'hello', chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Message sent');
      expect(send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });

    it('passes parentMessageId when provided', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Sent' });
      await dispatchToolCall('send_text', {
        text: 'hello',
        chatId: VALID_CHAT_ID,
        parentMessageId: 'parent_123',
      });
      expect(send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: VALID_CHAT_ID,
        parentMessageId: 'parent_123',
      });
    });

    it('prefixes handler failure with ⚠️', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: false, message: 'IPC error' });
      const result = await dispatchToolCall('send_text', { text: 'hi', chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.content[0].text).toContain('⚠️');
    });
  });

  describe('send_card', () => {
    const validCard = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [],
    };

    it('rejects null card', async () => {
      const result = await dispatchToolCall('send_card', { card: null, chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
      expect(send_card).not.toHaveBeenCalled();
    });

    it('rejects array card', async () => {
      const result = await dispatchToolCall('send_card', { card: [], chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('array');
      expect(send_card).not.toHaveBeenCalled();
    });

    it('rejects string card', async () => {
      const result = await dispatchToolCall('send_card', { card: 'not an object', chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
      expect(send_card).not.toHaveBeenCalled();
    });

    it('rejects card with invalid structure', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(false);
      const result = await dispatchToolCall('send_card', { card: { foo: 'bar' }, chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card structure');
      expect(send_card).not.toHaveBeenCalled();
    });

    it('rejects missing chatId', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(true);
      const result = await dispatchToolCall('send_card', { card: validCard }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
      expect(send_card).not.toHaveBeenCalled();
    });

    it('calls send_card on valid input', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(true);
      vi.mocked(send_card).mockResolvedValue({ success: true, message: 'Card sent' });
      const result = await dispatchToolCall('send_card', {
        card: validCard,
        chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Card sent');
      expect(send_card).toHaveBeenCalledWith({
        card: validCard,
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });
  });

  describe('send_interactive', () => {
    const validOptions = [
      { text: 'Approve', value: 'approve', type: 'primary' },
      { text: 'Reject', value: 'reject', type: 'danger' },
    ];

    it('rejects non-string question', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 123, options: validOptions, chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
      expect(send_interactive_message).not.toHaveBeenCalled();
    });

    it('rejects empty question', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: '', options: validOptions, chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('rejects non-array options', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: 'not array', chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('rejects empty options array', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: [], chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('rejects option with non-string text', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: [{ text: 42, value: 'v' }], chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].text');
    });

    it('rejects option with empty text', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: [{ text: '  ', value: 'v' }], chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].text');
    });

    it('rejects option with non-string value', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: [{ text: 'OK', value: true }], chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].value');
    });

    it('rejects option with empty value', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: [{ text: 'OK', value: '' }], chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].value');
    });

    it('rejects missing chatId', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: validOptions,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('detects invalid option at index > 0', async () => {
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one',
        options: [
          { text: 'OK', value: 'ok' },
          { text: 'Also OK', value: 'also' },
          { text: 99, value: 'bad' },
        ],
        chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[2].text');
    });

    it('calls send_interactive_message on valid input (optional fields default to undefined)', async () => {
      vi.mocked(send_interactive_message).mockResolvedValue({ success: true, message: 'Interactive sent' });
      const result = await dispatchToolCall('send_interactive', {
        question: 'Pick one', options: validOptions, chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Interactive sent');
      expect(send_interactive_message).toHaveBeenCalledWith({
        question: 'Pick one',
        options: validOptions,
        chatId: VALID_CHAT_ID,
        title: undefined,
        context: undefined,
        actionPrompts: undefined,
        parentMessageId: undefined,
      });
    });

    it('passes optional fields (title, context, actionPrompts, parentMessageId)', async () => {
      vi.mocked(send_interactive_message).mockResolvedValue({ success: true, message: 'Sent' });
      await dispatchToolCall('send_interactive', {
        question: 'Pick one',
        options: validOptions,
        chatId: VALID_CHAT_ID,
        title: 'My Title',
        context: 'Some context',
        actionPrompts: { approve: 'User approved', reject: 'User rejected' },
        parentMessageId: 'pm_123',
      });
      expect(send_interactive_message).toHaveBeenCalledWith({
        question: 'Pick one',
        options: validOptions,
        chatId: VALID_CHAT_ID,
        title: 'My Title',
        context: 'Some context',
        actionPrompts: { approve: 'User approved', reject: 'User rejected' },
        parentMessageId: 'pm_123',
      });
    });
  });

  describe('send_file', () => {
    it('rejects non-string filePath', async () => {
      const result = await dispatchToolCall('send_file', { filePath: 42, chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid filePath');
      expect(send_file).not.toHaveBeenCalled();
    });

    it('rejects missing chatId', async () => {
      const result = await dispatchToolCall('send_file', { filePath: '/tmp/file.pdf' }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
      expect(send_file).not.toHaveBeenCalled();
    });

    it('calls send_file on valid input (prefixed "File sent:")', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: true, message: 'report.pdf' });
      const result = await dispatchToolCall('send_file', {
        filePath: '/tmp/report.pdf', chatId: VALID_CHAT_ID,
      }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('File sent');
      expect(send_file).toHaveBeenCalledWith({
        filePath: '/tmp/report.pdf',
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });

    it('passes parentMessageId when provided', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: true, message: 'sent.pdf' });
      await dispatchToolCall('send_file', {
        filePath: '/tmp/file.pdf', chatId: VALID_CHAT_ID, parentMessageId: 'pm_999',
      });
      expect(send_file).toHaveBeenCalledWith({
        filePath: '/tmp/file.pdf',
        chatId: VALID_CHAT_ID,
        parentMessageId: 'pm_999',
      });
    });

    it('prefixes handler failure with ⚠️', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: false, message: 'File not found' });
      const result = await dispatchToolCall('send_file', { filePath: '/missing.pdf', chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.content[0].text).toContain('⚠️');
    });
  });

  describe('push_to_agent', () => {
    it('rejects missing chatId', async () => {
      const result = await dispatchToolCall('push_to_agent', { message: 'Hello' }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('chatId');
      expect(push_to_agent).not.toHaveBeenCalled();
    });

    it('rejects missing message', async () => {
      const result = await dispatchToolCall('push_to_agent', { chatId: VALID_CHAT_ID }) as ToolResult;
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('message');
      expect(push_to_agent).not.toHaveBeenCalled();
    });

    it('calls push_to_agent on valid input and returns success', async () => {
      vi.mocked(push_to_agent).mockResolvedValue({ success: true, message: 'Instruction pushed successfully' });
      const result = await dispatchToolCall('push_to_agent', {
        chatId: VALID_CHAT_ID, message: 'Test instruction',
      }) as ToolResult;
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('pushed');
      expect(push_to_agent).toHaveBeenCalledWith({ chatId: VALID_CHAT_ID, message: 'Test instruction' });
    });

    it('prefixes handler failure with ⚠️', async () => {
      vi.mocked(push_to_agent).mockResolvedValue({ success: false, message: 'IPC unavailable' });
      const result = await dispatchToolCall('push_to_agent', { chatId: VALID_CHAT_ID, message: 'Hello' }) as ToolResult;
      expect(result.content[0].text).toContain('⚠️');
    });
  });

  describe('unknown tool', () => {
    it('throws on unknown tool (router wraps as -32603)', async () => {
      await expect(dispatchToolCall('unknown_tool', {})).rejects.toThrow('Unknown tool');
    });
  });

  describe('error propagation', () => {
    it('propagates handler rejections unchanged (router owns -32603 wrapping)', async () => {
      vi.mocked(send_text).mockRejectedValue(new Error('IPC connection refused'));
      await expect(
        dispatchToolCall('send_text', { text: 'hi', chatId: VALID_CHAT_ID }),
      ).rejects.toThrow('IPC connection refused');
    });
  });
});

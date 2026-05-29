/**
 * Tests for MCP Server CLI (packages/mcp-server/src/cli.ts)
 *
 * Covers parseArgs() argument parsing and handleRequest() JSON-RPC dispatch
 * with pre-validation for all 4 tools (send_text, send_card, send_interactive, send_file).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before imports
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  loadConfigFile: vi.fn(),
  setLoadedConfig: vi.fn(),
  getIpcSocketPath: vi.fn(() => '/tmp/test-ipc.sock'),
}));

vi.mock('./index.js', () => ({
  setMessageSentCallback: vi.fn(),
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_file: vi.fn(),
  send_interactive_message: vi.fn(),
}));

vi.mock('./utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn(),
  getCardValidationError: vi.fn((_card: unknown) => 'missing config/header/elements'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
}));

// Import after mocks are set up
import { parseArgs, handleRequest } from './cli.js';
import { send_text, send_card, send_file, send_interactive_message } from './index.js';
import { isValidFeishuCard } from './utils/card-validator.js';

const VALID_CHAT_ID = 'oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function makeRequest(method: string, params?: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

describe('parseArgs', () => {
  it('should default to help command', () => {
    const result = parseArgs([]);
    expect(result.command).toBe('help');
  });

  it('should parse start command', () => {
    const result = parseArgs(['start']);
    expect(result.command).toBe('start');
  });

  it('should parse --config flag with value', () => {
    const result = parseArgs(['start', '--config', '/path/to/config.yaml']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('/path/to/config.yaml');
  });

  it('should parse -c flag with value', () => {
    const result = parseArgs(['start', '-c', '/etc/disclaude.yaml']);
    expect(result.configPath).toBe('/etc/disclaude.yaml');
  });

  it('should parse --help flag', () => {
    const result = parseArgs(['--help']);
    expect(result.command).toBe('help');
  });

  it('should parse -h flag', () => {
    const result = parseArgs(['-h']);
    expect(result.command).toBe('help');
  });

  it('should ignore --config without value', () => {
    const result = parseArgs(['start', '--config']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBeUndefined();
  });

  it('should handle start with config combined', () => {
    const result = parseArgs(['--config', 'my.yaml', 'start']);
    expect(result.command).toBe('start');
    expect(result.configPath).toBe('my.yaml');
  });

  it('should override start with help when --help is later', () => {
    const result = parseArgs(['start', '--help']);
    expect(result.command).toBe('help');
  });
});

describe('handleRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    it('should return MCP handshake with capabilities', async () => {
      const response = await handleRequest(makeRequest('initialize'));
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toBeDefined();
      expect(response.result).toEqual({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'channel-mcp', version: '0.0.1' },
      });
    });
  });

  describe('tools/list', () => {
    it('should return all 4 tool definitions', async () => {
      const response = await handleRequest(makeRequest('tools/list'));
      expect(response.result).toBeDefined();
      const {tools} = (response.result as { tools: { name: string }[] });
      expect(tools).toHaveLength(4);
      const names = tools.map((t) => t.name);
      expect(names).toContain('send_text');
      expect(names).toContain('send_card');
      expect(names).toContain('send_interactive');
      expect(names).toContain('send_file');
    });
  });

  describe('send_text validation', () => {
    it('should reject non-string text', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 123, chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid text');
    });

    it('should reject missing chatId', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hello' } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should reject non-string chatId', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hello', chatId: 42 } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should call send_text on valid input and return success', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Message sent' });
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hello', chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content[0].text).toContain('Message sent');
      expect(send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });

    it('should pass parentMessageId when provided', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: true, message: 'Sent' });
      await handleRequest(
        makeRequest('tools/call', {
          name: 'send_text',
          arguments: { text: 'hello', chatId: VALID_CHAT_ID, parentMessageId: 'parent_123' },
        }),
      );
      expect(send_text).toHaveBeenCalledWith({
        text: 'hello',
        chatId: VALID_CHAT_ID,
        parentMessageId: 'parent_123',
      });
    });

    it('should return warning on send_text failure', async () => {
      vi.mocked(send_text).mockResolvedValue({ success: false, message: 'IPC error' });
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hi', chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content[0].text).toContain('⚠️');
    });
  });

  describe('send_card validation', () => {
    const validCard = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [],
    };

    it('should reject null card', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_card', arguments: { card: null, chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should reject array card', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_card', arguments: { card: [], chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('array');
    });

    it('should reject string card', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_card', arguments: { card: 'not an object', chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card');
    });

    it('should reject card with invalid structure', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(false);
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_card', arguments: { card: { foo: 'bar' }, chatId: VALID_CHAT_ID } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid card structure');
    });

    it('should reject missing chatId', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(true);
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_card', arguments: { card: validCard } }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should call send_card on valid input', async () => {
      vi.mocked(isValidFeishuCard).mockReturnValue(true);
      vi.mocked(send_card).mockResolvedValue({ success: true, message: 'Card sent' });
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_card',
          arguments: { card: validCard, chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content[0].text).toContain('Card sent');
      expect(send_card).toHaveBeenCalledWith({
        card: validCard,
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });
  });

  describe('send_interactive validation', () => {
    const validOptions = [
      { text: 'Approve', value: 'approve', type: 'primary' },
      { text: 'Reject', value: 'reject', type: 'danger' },
    ];

    it('should reject non-string question', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 123, options: validOptions, chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should reject empty question', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: '', options: validOptions, chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid question');
    });

    it('should reject non-array options', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: 'not array', chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should reject empty options array', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: [], chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid options');
    });

    it('should reject option with non-string text', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: [{ text: 42, value: 'v' }], chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].text');
    });

    it('should reject option with empty text', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: [{ text: '  ', value: 'v' }], chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].text');
    });

    it('should reject option with non-string value', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: [{ text: 'OK', value: true }], chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].value');
    });

    it('should reject option with empty value', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: [{ text: 'OK', value: '' }], chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[0].value');
    });

    it('should reject missing chatId', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: validOptions },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should call send_interactive_message on valid input', async () => {
      vi.mocked(send_interactive_message).mockResolvedValue({ success: true, message: 'Interactive sent' });
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: { question: 'Pick one', options: validOptions, chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
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

    it('should pass optional fields (title, context, actionPrompts, parentMessageId)', async () => {
      vi.mocked(send_interactive_message).mockResolvedValue({ success: true, message: 'Sent' });
      await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: {
            question: 'Pick one',
            options: validOptions,
            chatId: VALID_CHAT_ID,
            title: 'My Title',
            context: 'Some context',
            actionPrompts: { approve: 'User approved', reject: 'User rejected' },
            parentMessageId: 'pm_123',
          },
        }),
      );
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

    it('should detect invalid option at index > 0', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_interactive',
          arguments: {
            question: 'Pick one',
            options: [
              { text: 'OK', value: 'ok' },
              { text: 'Also OK', value: 'also' },
              { text: 99, value: 'bad' },
            ],
            chatId: VALID_CHAT_ID,
          },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('options[2].text');
    });
  });

  describe('send_file validation', () => {
    it('should reject non-string filePath', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_file',
          arguments: { filePath: 42, chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid filePath');
    });

    it('should reject missing chatId', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_file',
          arguments: { filePath: '/tmp/file.pdf' },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[]; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid chatId');
    });

    it('should call send_file on valid input', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: true, message: 'report.pdf' });
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_file',
          arguments: { filePath: '/tmp/report.pdf', chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content[0].text).toContain('File sent');
      expect(send_file).toHaveBeenCalledWith({
        filePath: '/tmp/report.pdf',
        chatId: VALID_CHAT_ID,
        parentMessageId: undefined,
      });
    });

    it('should pass parentMessageId when provided', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: true, message: 'sent.pdf' });
      await handleRequest(
        makeRequest('tools/call', {
          name: 'send_file',
          arguments: { filePath: '/tmp/file.pdf', chatId: VALID_CHAT_ID, parentMessageId: 'pm_999' },
        }),
      );
      expect(send_file).toHaveBeenCalledWith({
        filePath: '/tmp/file.pdf',
        chatId: VALID_CHAT_ID,
        parentMessageId: 'pm_999',
      });
    });

    it('should return warning on send_file failure', async () => {
      vi.mocked(send_file).mockResolvedValue({ success: false, message: 'File not found' });
      const response = await handleRequest(
        makeRequest('tools/call', {
          name: 'send_file',
          arguments: { filePath: '/missing.pdf', chatId: VALID_CHAT_ID },
        }),
      );
      const result = response.result as { content: { type: string; text: string }[] };
      expect(result.content[0].text).toContain('⚠️');
    });
  });

  describe('unknown method/tool', () => {
    it('should return error for unknown method', async () => {
      const response = await handleRequest(makeRequest('unknown/method'));
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown method');
    });

    it('should return error for unknown tool', async () => {
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'unknown_tool', arguments: {} }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.message).toContain('Unknown tool');
    });
  });

  describe('error handling', () => {
    it('should catch thrown errors and return JSON-RPC error', async () => {
      vi.mocked(send_text).mockRejectedValue(new Error('IPC connection refused'));
      const response = await handleRequest(
        makeRequest('tools/call', { name: 'send_text', arguments: { text: 'hi', chatId: VALID_CHAT_ID } }),
      );
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
      expect(response.error!.message).toContain('IPC connection refused');
    });
  });
});

/**
 * Tests for MCP Server CLI — handleRequest() validation logic.
 *
 * Since parseArgs() and handleRequest() are not exported from cli.ts,
 * we extract handleRequest by intercepting the stdin data handler after
 * importing the module. The module calls main() which sets up stdin listeners.
 *
 * Related: Issue #1617 — test coverage improvement
 */

import { describe, it, expect, vi, beforeEach, afterEach, type SpyInstance } from 'vitest';

// Mock tool implementations before importing
vi.mock('./index.js', () => ({
  setMessageSentCallback: vi.fn(),
  send_file: vi.fn(),
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive_message: vi.fn(),
}));

vi.mock('./utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn().mockReturnValue(true),
  getCardValidationError: vi.fn().mockReturnValue('invalid card structure'),
}));

vi.mock('@disclaude/core', () => ({
  loadConfigFile: vi.fn(),
  setLoadedConfig: vi.fn(),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcSocketPath: vi.fn().mockReturnValue('/tmp/test.sock'),
}));

import { send_text, send_card, send_file, send_interactive_message } from './index.js';
import { isValidFeishuCard, getCardValidationError } from './utils/card-validator.js';

const mockSendText = vi.mocked(send_text);
const mockSendCard = vi.mocked(send_card);
const mockSendFile = vi.mocked(send_file);
const mockSendInteractive = vi.mocked(send_interactive_message);
const mockIsValidCard = vi.mocked(isValidFeishuCard);
const mockGetCardError = vi.mocked(getCardValidationError);

/**
 * Helper to invoke handleRequest by sending a JSON-RPC message through stdin.
 *
 * When cli.ts is imported, main() runs and attaches a 'data' listener to stdin.
 * We capture this listener and invoke it with a JSON-RPC message, then capture
 * the stdout output.
 */
function makeRequest(request: Record<string, unknown>): Promise<string | undefined> {
  // Get the stdin 'data' listener that main() registered
  const listeners = process.stdin.listeners('data');
  if (listeners.length === 0) {
    throw new Error('No stdin data listener found — was cli.ts imported?');
  }
  const dataListener = listeners[listeners.length - 1] as (chunk: Buffer) => Promise<void>;

  // Capture stdout output
  const outputs: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
    outputs.push(msg);
  });

  // Send the request as a JSON line
  const line = `${JSON.stringify(request)}\n`;
  void dataListener(Buffer.from(line));

  // Wait for async handler to complete
  return new Promise((resolve) => {
    setTimeout(() => {
      logSpy.mockRestore();
      resolve(outputs[0]);
    }, 50);
  });
}

describe('CLI handleRequest', () => {
  let exitSpy: SpyInstance;
  let logSpy: SpyInstance;
  let errorSpy: SpyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Import the module once to set up stdin listeners
  // main() will call process.exit(0) for help (no args), which we mock
  let moduleImported = false;

  async function ensureModuleLoaded() {
    if (!moduleImported) {
      // Set argv to trigger 'start' command so main() doesn't exit
      process.argv = ['node', 'cli.js', 'start'];
      await import('./cli.js');
      moduleImported = true;
    }
  }

  describe('initialize method', () => {
    it('should return server capabilities', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
      });

      expect(output).toBeDefined();
      const response = JSON.parse(output!);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result.protocolVersion).toBe('2024-11-05');
      expect(response.result.capabilities).toEqual({ tools: {} });
      expect(response.result.serverInfo.name).toBe('channel-mcp');
    });
  });

  describe('tools/list method', () => {
    it('should return all four tool definitions', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      });

      expect(output).toBeDefined();
      const response = JSON.parse(output!);
      expect(response.id).toBe(2);
      const { tools } = response.result;
      const names = tools.map((t: { name: string }) => t.name);
      expect(names).toContain('send_text');
      expect(names).toContain('send_card');
      expect(names).toContain('send_interactive');
      expect(names).toContain('send_file');
      expect(tools).toHaveLength(4);
    });

    it('should include required fields in send_text schema', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      });

      const response = JSON.parse(output!);
      const sendText = response.result.tools.find(
        (t: { name: string }) => t.name === 'send_text',
      );
      expect(sendText.inputSchema.required).toContain('text');
      expect(sendText.inputSchema.required).toContain('chatId');
    });
  });

  describe('tools/call — send_text', () => {
    it('should reject non-string text', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 123, chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.id).toBe(10);
      expect(response.result.content[0].text).toContain('Invalid text');
      expect(response.result.isError).toBe(true);
    });

    it('should reject empty chatId', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 'hello', chatId: '' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid chatId');
      expect(response.result.isError).toBe(true);
    });

    it('should call send_text and return success message', async () => {
      mockSendText.mockResolvedValue({ success: true, message: 'Message sent' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 'hello', chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('Message sent');
      expect(response.result.isError).toBeUndefined();
    });

    it('should prefix failure message with warning emoji', async () => {
      mockSendText.mockResolvedValue({ success: false, message: 'Send failed' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 'hello', chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('⚠️ Send failed');
    });

    it('should pass parentMessageId to send_text', async () => {
      mockSendText.mockResolvedValue({ success: true, message: 'ok' });
      await ensureModuleLoaded();

      await makeRequest({
        jsonrpc: '2.0',
        id: 14,
        method: 'tools/call',
        params: {
          name: 'send_text',
          arguments: { text: 'hello', chatId: 'oc_xxx', parentMessageId: 'om_parent' },
        },
      });

      expect(mockSendText).toHaveBeenCalledWith(
        expect.objectContaining({ parentMessageId: 'om_parent' }),
      );
    });
  });

  describe('tools/call — send_card', () => {
    it('should reject null card', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 20,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: { card: null, chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid card');
      expect(response.result.isError).toBe(true);
    });

    it('should reject array card', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: { card: [], chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('array');
      expect(response.result.isError).toBe(true);
    });

    it('should reject card that fails isValidFeishuCard', async () => {
      mockIsValidCard.mockReturnValue(false);
      mockGetCardError.mockReturnValue('missing required fields: config');
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: { card: { foo: 'bar' }, chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid card structure');
      expect(response.result.isError).toBe(true);
    });

    it('should reject empty chatId', async () => {
      mockIsValidCard.mockReturnValue(true);
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: {
            card: { config: {}, header: { title: 'T' }, elements: [] },
            chatId: '',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid chatId');
      expect(response.result.isError).toBe(true);
    });

    it('should send valid card and return success', async () => {
      mockIsValidCard.mockReturnValue(true);
      mockSendCard.mockResolvedValue({ success: true, message: 'Card sent' });
      await ensureModuleLoaded();

      const card = {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      };
      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: { card, chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('Card sent');
      expect(response.result.isError).toBeUndefined();
    });

    it('should prefix card failure with warning emoji', async () => {
      mockIsValidCard.mockReturnValue(true);
      mockSendCard.mockResolvedValue({ success: false, message: 'Card rejected' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: {
          name: 'send_card',
          arguments: {
            card: { config: {}, header: { title: 'T' }, elements: [] },
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('⚠️ Card rejected');
    });
  });

  describe('tools/call — send_interactive', () => {
    it('should reject empty question', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 30,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: '',
            options: [{ text: 'A', value: 'a' }],
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid question');
      expect(response.result.isError).toBe(true);
    });

    it('should reject non-string question', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 123,
            options: [{ text: 'A', value: 'a' }],
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid question');
    });

    it('should reject empty options array', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 32,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: { question: 'Q?', options: [], chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid options');
      expect(response.result.isError).toBe(true);
    });

    it('should reject option with whitespace-only text', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 'Q?',
            options: [{ text: '   ', value: 'a' }],
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('options[0].text');
      expect(response.result.isError).toBe(true);
    });

    it('should reject option with empty value', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 34,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 'Q?',
            options: [{ text: 'OK', value: '' }],
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('options[0].value');
      expect(response.result.isError).toBe(true);
    });

    it('should report first invalid option index', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 35,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 'Q?',
            options: [
              { text: 'OK', value: 'a' },
              { text: '', value: 'b' },
              { text: '', value: 'c' },
            ],
            chatId: 'oc_xxx',
          },
        },
      });

      const response = JSON.parse(output!);
      // Should report options[1] first, not options[2]
      expect(response.result.content[0].text).toContain('options[1].text');
    });

    it('should reject empty chatId', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 36,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 'Q?',
            options: [{ text: 'A', value: 'a' }],
            chatId: '',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid chatId');
    });

    it('should send valid interactive card and return success', async () => {
      mockSendInteractive.mockResolvedValue({ success: true, message: 'Interactive sent' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 37,
        method: 'tools/call',
        params: {
          name: 'send_interactive',
          arguments: {
            question: 'Pick one',
            options: [{ text: 'A', value: 'a', type: 'primary' }],
            chatId: 'oc_xxx',
            title: 'Test Title',
            context: 'Some context',
            actionPrompts: { a: 'prompt A' },
            parentMessageId: 'om_parent',
          },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('Interactive sent');
      expect(response.result.isError).toBeUndefined();

      expect(mockSendInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          question: 'Pick one',
          chatId: 'oc_xxx',
          title: 'Test Title',
          context: 'Some context',
          actionPrompts: { a: 'prompt A' },
          parentMessageId: 'om_parent',
        }),
      );
    });
  });

  describe('tools/call — send_file', () => {
    it('should reject non-string filePath', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: {
          name: 'send_file',
          arguments: { filePath: 123, chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid filePath');
      expect(response.result.isError).toBe(true);
    });

    it('should reject empty chatId', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: 'send_file',
          arguments: { filePath: '/tmp/test.pdf', chatId: '' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toContain('Invalid chatId');
    });

    it('should send file and prefix with "File sent:" on success', async () => {
      mockSendFile.mockResolvedValue({ success: true, message: 'test.pdf' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: 'send_file',
          arguments: { filePath: '/tmp/test.pdf', chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('File sent: test.pdf');
    });

    it('should prefix failure with warning emoji', async () => {
      mockSendFile.mockResolvedValue({ success: false, message: 'Upload failed' });
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: {
          name: 'send_file',
          arguments: { filePath: '/tmp/test.pdf', chatId: 'oc_xxx' },
        },
      });

      const response = JSON.parse(output!);
      expect(response.result.content[0].text).toBe('⚠️ Upload failed');
    });

    it('should handle non-string parentMessageId as undefined', async () => {
      mockSendFile.mockResolvedValue({ success: true, message: 'ok' });
      await ensureModuleLoaded();

      await makeRequest({
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: {
          name: 'send_file',
          arguments: { filePath: '/tmp/test.pdf', chatId: 'oc_xxx', parentMessageId: 123 },
        },
      });

      expect(mockSendFile).toHaveBeenCalledWith(
        expect.objectContaining({ parentMessageId: undefined }),
      );
    });
  });

  describe('unknown method', () => {
    it('should return JSON-RPC error for unknown method', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 50,
        method: 'unknown/method',
      });

      const response = JSON.parse(output!);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('Unknown method');
    });

    it('should return JSON-RPC error for unknown tool name', async () => {
      await ensureModuleLoaded();

      const output = await makeRequest({
        jsonrpc: '2.0',
        id: 51,
        method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      });

      const response = JSON.parse(output!);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toContain('Unknown tool');
    });
  });
});

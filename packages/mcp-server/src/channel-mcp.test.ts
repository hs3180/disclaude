/**
 * Tests for channel-mcp tool handlers — specifically the isError signaling.
 *
 * Issue #1634: When tool operations fail, handlers must return { isError: true }
 * so the Agent stops retrying/diagnosing and reports the error to the user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all tool implementations before importing the module
vi.mock('./tools/index.js', () => ({
  send_text: vi.fn(),
  send_card: vi.fn(),
  send_interactive: vi.fn(),
  send_file: vi.fn(),
  register_temp_chat: vi.fn(),
  setMessageSentCallback: vi.fn(),
}));

vi.mock('./utils/card-validator.js', () => ({
  isValidFeishuCard: vi.fn().mockReturnValue(true),
  getCardValidationError: vi.fn().mockReturnValue('invalid card structure'),
}));

vi.mock('@disclaude/core', () => ({
  getProvider: () => ({
    createInlineTool: (def: { handler: unknown }) => ({ definition: def }),
    createMcpServer: (config: unknown) => ({ config }),
  }),
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
  getIpcSocketPath: vi.fn(),
  Config: { get: vi.fn() },
}));

// Import after mocks are set up
import { channelToolDefinitions } from './channel-mcp.js';
import { send_text, send_card, send_interactive, send_file, register_temp_chat } from './tools/index.js';

const mocked_send_text = vi.mocked(send_text);
const mocked_send_card = vi.mocked(send_card);
const mocked_send_interactive = vi.mocked(send_interactive);
const mocked_send_file = vi.mocked(send_file);
const mocked_register_temp_chat = vi.mocked(register_temp_chat);

// Valid-length chatId for tests (validator requires oc_ prefix + 32 chars = 35 min)
const VALID_CHAT_ID = 'oc_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

function getHandler(name: string) {
  const def = channelToolDefinitions.find(d => d.name === name);
  if (!def) { throw new Error(`Tool "${name}" not found`); }
  return def.handler;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// send_text handler
// ============================================================================
describe('send_text handler', () => {
  const handler = getHandler('send_text');

  it('should return success without isError on successful send', async () => {
    mocked_send_text.mockResolvedValue({ success: true, message: '✅ Message sent' });
    const result = await handler({ text: 'Hello', chatId: VALID_CHAT_ID });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('✅ Message sent');
  });

  it('should return isError: true when send fails', async () => {
    mocked_send_text.mockResolvedValue({ success: false, message: '❌ Send failed' });
    const result = await handler({ text: 'Hello', chatId: VALID_CHAT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('❌ Send failed');
  });

  it('should return isError: true when send throws', async () => {
    mocked_send_text.mockRejectedValue(new Error('Network error'));
    const result = await handler({ text: 'Hello', chatId: VALID_CHAT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network error');
  });
});

// ============================================================================
// send_card handler
// ============================================================================
describe('send_card handler', () => {
  const handler = getHandler('send_card');

  it('should return success without isError on valid card send', async () => {
    mocked_send_card.mockResolvedValue({ success: true, message: '✅ Card sent' });
    const result = await handler({
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      },
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('✅ Card sent');
  });

  it('should return isError: true for invalid card type', async () => {
    const result = await handler({ card: 'not-an-object', chatId: VALID_CHAT_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid card');
  });

  it('should return isError: true for array card', async () => {
    const result = await handler({ card: [], chatId: VALID_CHAT_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid card');
  });

  it('should return isError: true for null card', async () => {
    const result = await handler({ card: null, chatId: VALID_CHAT_ID });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid card');
  });

  it('should return isError: true for empty chatId', async () => {
    const result = await handler({
      card: { config: {}, header: {}, elements: [] },
      chatId: '',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid chatId');
  });

  it('should return isError: true when send_card fails', async () => {
    mocked_send_card.mockResolvedValue({ success: false, message: '❌ Card rejected' });
    const result = await handler({
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      },
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('❌ Card rejected');
  });

  it('should return isError: true when send_card throws', async () => {
    mocked_send_card.mockRejectedValue(new Error('IPC timeout'));
    const result = await handler({
      card: {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: 'Test' } },
        elements: [],
      },
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('IPC timeout');
  });
});

// ============================================================================
// send_interactive handler
// ============================================================================
describe('send_interactive handler', () => {
  const handler = getHandler('send_interactive');

  it('should return success without isError on valid interactive card', async () => {
    mocked_send_interactive.mockResolvedValue({ success: true, message: '✅ Interactive card sent' });
    const result = await handler({
      question: 'Pick one',
      options: [{ text: 'A', value: 'a' }],
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('✅ Interactive card sent');
  });

  it('should return isError: true for empty question', async () => {
    const result = await handler({
      question: '',
      options: [{ text: 'A', value: 'a' }],
      chatId: VALID_CHAT_ID,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid question');
  });

  it('should return isError: true for empty options array', async () => {
    const result = await handler({
      question: 'Pick one',
      options: [],
      chatId: VALID_CHAT_ID,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid options');
  });

  it('should return isError: true for non-string chatId', async () => {
    const result = await handler({
      question: 'Pick one',
      options: [{ text: 'A', value: 'a' }],
      chatId: 123 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid chatId');
  });

  it('should return isError: true when send_interactive fails', async () => {
    mocked_send_interactive.mockResolvedValue({ success: false, message: '❌ Failed to create card' });
    const result = await handler({
      question: 'Pick one',
      options: [{ text: 'A', value: 'a' }],
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('❌ Failed to create card');
  });

  it('should return isError: true when send_interactive throws', async () => {
    mocked_send_interactive.mockRejectedValue(new Error('Rate limited'));
    const result = await handler({
      question: 'Pick one',
      options: [{ text: 'A', value: 'a' }],
      chatId: VALID_CHAT_ID,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Rate limited');
  });
});

// ============================================================================
// send_file handler — the primary issue #1634 scenario
// ============================================================================
describe('send_file handler', () => {
  const handler = getHandler('send_file');

  it('should return success without isError on successful file send', async () => {
    mocked_send_file.mockResolvedValue({
      success: true,
      message: '✅ File sent: test.txt (0.00 MB)',
      fileName: 'test.txt',
      fileSize: 0,
      sizeMB: '0.00',
    });
    const result = await handler({ filePath: 'test.txt', chatId: VALID_CHAT_ID });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('✅ File sent');
  });

  it('should return isError: true when credentials not configured', async () => {
    // This is the exact scenario from Issue #1634
    mocked_send_file.mockResolvedValue({
      success: false,
      message: '⚠️ File cannot be sent: Platform is not configured.',
      error: 'Platform credentials not configured',
    });
    const result = await handler({ filePath: 'test.txt', chatId: VALID_CHAT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Platform is not configured');
  });

  it('should return isError: true when IPC not available', async () => {
    mocked_send_file.mockResolvedValue({
      success: false,
      message: '❌ File upload requires IPC connection.',
      error: 'IPC not available',
    });
    const result = await handler({ filePath: 'test.txt', chatId: VALID_CHAT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('IPC connection');
  });

  it('should return isError: true when upload fails', async () => {
    mocked_send_file.mockRejectedValue(new Error('Failed to upload file via IPC'));
    const result = await handler({ filePath: 'test.txt', chatId: VALID_CHAT_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to upload file via IPC');
  });
});

// ============================================================================
// register_temp_chat handler
// ============================================================================
describe('register_temp_chat handler', () => {
  const handler = getHandler('register_temp_chat');

  it('should return success for valid registration', async () => {
    mocked_register_temp_chat.mockResolvedValue({
      success: true,
      message: '✅ Temporary chat registered',
    });
    const result = await handler({ chatId: VALID_CHAT_ID });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('✅ Temporary chat registered');
  });
});

/**
 * Tests for Unified Messaging MCP Tools.
 *
 * Issue #590 Phase 2: MCP Tools 与 Channel 解耦
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectChannel, send_message } from './unified-messaging-mcp.js';

describe('detectChannel', () => {
  it('should detect CLI channel for cli- prefix', () => {
    expect(detectChannel('cli-12345')).toBe('cli');
    expect(detectChannel('cli-test-session')).toBe('cli');
  });

  it('should detect Feishu channel for oc_ prefix (group chat)', () => {
    expect(detectChannel('oc_abcd1234')).toBe('feishu');
    expect(detectChannel('oc_xxxxxxxxxxxxxxxx')).toBe('feishu');
  });

  it('should detect Feishu channel for ou_ prefix (private chat)', () => {
    expect(detectChannel('ou_abcd1234')).toBe('feishu');
    expect(detectChannel('ou_xxxxxxxxxxxxxxxx')).toBe('feishu');
  });

  it('should detect REST channel for other prefixes', () => {
    expect(detectChannel('rest-123')).toBe('rest');
    expect(detectChannel('chat-456')).toBe('rest');
    expect(detectChannel('default')).toBe('rest');
    expect(detectChannel('any-other-id')).toBe('rest');
  });
});

describe('send_message', () => {
  // Mock send_message from feishu-context-mcp
  vi.mock('./feishu-context-mcp.js', () => ({
    send_message: vi.fn(),
    setMessageSentCallback: vi.fn(),
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('should route CLI messages correctly', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: true,
      message: '✅ Feedback displayed (CLI mode)',
    });

    const result = await send_message({
      content: 'Hello CLI',
      format: 'text',
      chatId: 'cli-test',
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe('cli');
    expect(mockSendMessage).toHaveBeenCalledWith({
      content: 'Hello CLI',
      format: 'text',
      chatId: 'cli-test',
      parentMessageId: undefined,
    });
  });

  it('should route Feishu messages correctly', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: true,
      message: '✅ Feedback sent',
    });

    const result = await send_message({
      content: 'Hello Feishu',
      format: 'text',
      chatId: 'oc_test123',
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe('feishu');
    expect(mockSendMessage).toHaveBeenCalledWith({
      content: 'Hello Feishu',
      format: 'text',
      chatId: 'oc_test123',
      parentMessageId: undefined,
    });
  });

  it('should route REST messages correctly', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: true,
      message: '✅ Feedback logged (Feishu not configured)',
    });

    const result = await send_message({
      content: 'Hello REST',
      format: 'text',
      chatId: 'rest-chat-1',
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe('rest');
    expect(mockSendMessage).toHaveBeenCalledWith({
      content: 'Hello REST',
      format: 'text',
      chatId: 'rest-chat-1',
      parentMessageId: undefined,
    });
  });

  it('should pass parentMessageId for thread replies', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: true,
      message: '✅ Feedback sent',
    });

    const result = await send_message({
      content: 'Reply',
      format: 'text',
      chatId: 'oc_test',
      parentMessageId: 'msg_parent123',
    });

    expect(result.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith({
      content: 'Reply',
      format: 'text',
      chatId: 'oc_test',
      parentMessageId: 'msg_parent123',
    });
  });

  it('should handle card format', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: true,
      message: '✅ Card sent',
    });

    const cardContent = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' }, template: 'blue' },
      elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'Hello' } }],
    };

    const result = await send_message({
      content: cardContent,
      format: 'card',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);
    expect(result.channel).toBe('feishu');
  });

  it('should handle errors gracefully', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockResolvedValue({
      success: false,
      message: '❌ Failed: Invalid card',
      error: 'Invalid card structure',
    });

    const result = await send_message({
      content: 'test',
      format: 'card',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid card structure');
  });

  it('should handle exceptions', async () => {
    const mockSendMessage = vi.mocked(await import('./feishu-context-mcp.js')).send_message;
    mockSendMessage.mockRejectedValue(new Error('Network error'));

    const result = await send_message({
      content: 'test',
      format: 'text',
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
    expect(result.channel).toBe('feishu');
  });
});

/**
 * Tests for inject_prompt tool implementation.
 *
 * Issue #631: Non-blocking interaction — inject prompt into chat agent.
 *
 * @module mcp-server/tools/inject-prompt.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @disclaude/core before importing inject_prompt
const mockInjectPrompt = vi.fn();
const mockConnect = vi.fn();
const mockIsConnected = vi.fn().mockReturnValue(false);
const mockDisconnect = vi.fn();

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  getIpcClient: () => ({
    injectPrompt: mockInjectPrompt,
    connect: mockConnect,
    isConnected: mockIsConnected,
    disconnect: mockDisconnect,
  }),
}));

// Mock ipc-utils
const mockIsIpcAvailable = vi.fn().mockResolvedValue(true);
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: () => mockIsIpcAvailable(),
  getIpcErrorMessage: vi.fn((type, err) => `Error: ${err}`),
}));

// Mock credentials
vi.mock('./credentials.js', () => ({
  getFeishuCredentials: () => ({ appId: 'test-app-id', appSecret: 'test-secret' }),
}));

import { inject_prompt } from './inject-prompt.js';

describe('inject_prompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset IPC availability mock to return true by default
    mockIsIpcAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should inject prompt successfully', async () => {
    mockInjectPrompt.mockResolvedValue({ success: true });

    const result = await inject_prompt({
      chatId: 'oc_test123',
      prompt: 'You are a discussion moderator.',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('Prompt injected');
    expect(mockInjectPrompt).toHaveBeenCalledWith('oc_test123', 'You are a discussion moderator.');
  });

  it('should return error when prompt is empty', async () => {
    const result = await inject_prompt({
      chatId: 'oc_test123',
      prompt: '',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('prompt is required');
    expect(mockInjectPrompt).not.toHaveBeenCalled();
  });

  it('should return error when chatId is empty', async () => {
    const result = await inject_prompt({
      chatId: '',
      prompt: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('chatId is required');
    expect(mockInjectPrompt).not.toHaveBeenCalled();
  });

  it('should return error when IPC fails', async () => {
    mockInjectPrompt.mockResolvedValue({
      success: false,
      error: 'Router not initialized',
      errorType: 'ipc_request_failed',
    });

    const result = await inject_prompt({
      chatId: 'oc_test123',
      prompt: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Router not initialized');
    expect(mockInjectPrompt).toHaveBeenCalledWith('oc_test123', 'Hello');
  });
});

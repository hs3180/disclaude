/**
 * Tests for push_to_agent tool implementation.
 *
 * Issue #631: Non-blocking interaction — push instruction to chat agent.
 *
 * @module mcp-server/tools/push-to-agent.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @disclaude/core before importing push_to_agent
const mockPushToAgent = vi.fn();
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
    pushToAgent: mockPushToAgent,
    connect: mockConnect,
    isConnected: mockIsConnected,
    disconnect: mockDisconnect,
  }),
}));

// Mock ipc-utils
const mockIsIpcAvailable = vi.fn().mockResolvedValue(true);
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: () => mockIsIpcAvailable(),
  getIpcErrorMessage: vi.fn((_type, err) => `Error: ${err}`),
}));

import { push_to_agent } from './push-to-agent.js';

describe('push_to_agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset IPC availability mock to return true by default
    mockIsIpcAvailable.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should push to agent successfully', async () => {
    mockPushToAgent.mockResolvedValue({ success: true });

    const result = await push_to_agent({
      chatId: 'oc_test123',
      message: 'You are a discussion moderator.',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('pushed to agent');
    expect(mockPushToAgent).toHaveBeenCalledWith('oc_test123', 'You are a discussion moderator.');
  });

  it('should return error when message is empty', async () => {
    const result = await push_to_agent({
      chatId: 'oc_test123',
      message: '',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('message is required');
    expect(mockPushToAgent).not.toHaveBeenCalled();
  });

  it('should return error when chatId is empty', async () => {
    const result = await push_to_agent({
      chatId: '',
      message: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('chatId is required');
    expect(mockPushToAgent).not.toHaveBeenCalled();
  });

  it('should return error when IPC fails', async () => {
    mockPushToAgent.mockResolvedValue({
      success: false,
      error: 'Router not initialized',
      errorType: 'ipc_request_failed',
    });

    const result = await push_to_agent({
      chatId: 'oc_test123',
      message: 'Hello',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Router not initialized');
    expect(mockPushToAgent).toHaveBeenCalledWith('oc_test123', 'Hello');
  });
});

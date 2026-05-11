/**
 * Tests for enqueue_task MCP tool (Issue #3334)
 *
 * Covers:
 * 1. Missing required parameters
 * 2. IPC unavailable
 * 3. Successful enqueue
 * 4. Failed enqueue (server-side rejection)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsIpcAvailable = vi.fn();
const mockEnqueueTask = vi.fn();

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: () => ({
    enqueueTask: mockEnqueueTask,
  }),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: () => mockIsIpcAvailable(),
}));

import { enqueue_task } from './enqueue-task.js';

describe('enqueue_task', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsIpcAvailable.mockResolvedValue(true);
    mockEnqueueTask.mockResolvedValue({
      success: true,
      messageId: 'test-msg-123',
    });
  });

  it('should reject missing sourceChatId', async () => {
    const result = await enqueue_task({
      sourceChatId: '',
      projectKey: 'owner/repo',
      payload: 'Do something',
      priority: 'normal',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('sourceChatId is required');
  });

  it('should reject missing projectKey', async () => {
    const result = await enqueue_task({
      sourceChatId: 'oc_chat',
      projectKey: '',
      payload: 'Do something',
      priority: 'normal',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('projectKey is required');
  });

  it('should reject missing payload', async () => {
    const result = await enqueue_task({
      sourceChatId: 'oc_chat',
      projectKey: 'owner/repo',
      payload: '',
      priority: 'normal',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('payload is required');
  });

  it('should reject when IPC unavailable', async () => {
    mockIsIpcAvailable.mockResolvedValue(false);

    const result = await enqueue_task({
      sourceChatId: 'oc_chat',
      projectKey: 'owner/repo',
      payload: 'Do something',
      priority: 'normal',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should succeed with valid parameters', async () => {
    const result = await enqueue_task({
      sourceChatId: 'oc_source',
      projectKey: 'owner/repo',
      payload: 'Analyze issues',
      priority: 'high',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('owner/repo');
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      'oc_source',
      'owner/repo',
      'Analyze issues',
      'high',
    );
  });

  it('should default priority to normal', async () => {
    const result = await enqueue_task({
      sourceChatId: 'oc_source',
      projectKey: 'owner/repo',
      payload: 'Do something',
      priority: 'normal',
    });

    expect(result.success).toBe(true);
    expect(mockEnqueueTask).toHaveBeenCalledWith(
      'oc_source',
      'owner/repo',
      'Do something',
      'normal',
    );
  });

  it('should handle server-side rejection', async () => {
    mockEnqueueTask.mockResolvedValue({
      success: false,
      error: 'Anti-recursion: cannot enqueue to your own project',
    });

    const result = await enqueue_task({
      sourceChatId: 'oc_source',
      projectKey: 'owner/repo',
      payload: 'Do something',
      priority: 'normal',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Anti-recursion');
  });

  it('should handle IPC client errors', async () => {
    mockEnqueueTask.mockRejectedValue(new Error('Connection refused'));

    const result = await enqueue_task({
      sourceChatId: 'oc_source',
      projectKey: 'owner/repo',
      payload: 'Do something',
      priority: 'normal',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Connection refused');
  });
});

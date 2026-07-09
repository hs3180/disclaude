/**
 * Tests for loop_start tool (packages/mcp-server/src/tools/loop-start.ts)
 *
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 *
 * These exercise real behavior — parameter validation, IPC availability, the
 * success path, and IPC failure — not just a stub.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies (matches the convention in send-message.test.ts)
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') { return '❌ IPC 服务不可用。'; }
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

import { loop_start } from './loop-start.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  loopStart: vi.fn(),
};

describe('loop_start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('returns an error when chatId is missing', async () => {
      const result = await loop_start({ chatId: '', prompt: 'do something' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
      expect(mockIpcClient.loopStart).not.toHaveBeenCalled();
    });

    it('returns an error when neither prompt nor loopMdPath is provided', async () => {
      const result = await loop_start({ chatId: 'oc_123', prompt: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('prompt or loopMdPath is required');
      expect(mockIpcClient.loopStart).not.toHaveBeenCalled();
    });
  });

  describe('IPC availability', () => {
    it('returns an error and does not call IPC when unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);

      const result = await loop_start({ chatId: 'oc_123', prompt: 'hi' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC service unavailable');
      expect(mockIpcClient.loopStart).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('starts a loop and returns the loopId, forwarding all params', async () => {
      mockIpcClient.loopStart.mockResolvedValue({ success: true, loopId: 'loop_abc' });

      const params = { chatId: 'oc_123', prompt: 'run', maxSteps: 5, stepIntervalMs: 1000 };
      const result = await loop_start(params);

      expect(result.success).toBe(true);
      expect(result.loopId).toBe('loop_abc');
      expect(result.message).toContain('loop_abc');
      expect(mockIpcClient.loopStart).toHaveBeenCalledWith(params);
    });

    it('forwards loopMdPath to IPC when prompt is omitted (Issue #4193 part B)', async () => {
      mockIpcClient.loopStart.mockResolvedValue({ success: true, loopId: 'loop_md' });

      const params = { chatId: 'oc_123', loopMdPath: '/ws/.disclaude/loop/x/LOOP.md' };
      const result = await loop_start(params);

      expect(result.success).toBe(true);
      expect(result.loopId).toBe('loop_md');
      expect(result.message).toContain('loop_md');
      expect(mockIpcClient.loopStart).toHaveBeenCalledWith(params);
    });
  });

  describe('IPC failure', () => {
    it('surfaces the IPC error when loopStart reports failure', async () => {
      mockIpcClient.loopStart.mockResolvedValue({
        success: false,
        errorType: 'ipc_request_failed',
        error: 'boom',
      });

      const result = await loop_start({ chatId: 'oc_123', prompt: 'hi' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('boom');
    });
  });
});

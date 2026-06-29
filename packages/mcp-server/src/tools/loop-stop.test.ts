/**
 * Tests for loop_stop tool (packages/mcp-server/src/tools/loop-stop.ts)
 *
 * Issue #4075: Loop = while loop + push_to_agent + counter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { loop_stop } from './loop-stop.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  loopStop: vi.fn(),
};

describe('loop_stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('returns an error when loopId is missing', async () => {
      const result = await loop_stop({ loopId: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('loopId is required');
      expect(mockIpcClient.loopStop).not.toHaveBeenCalled();
    });
  });

  describe('IPC availability', () => {
    it('returns an error and does not call IPC when unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);

      const result = await loop_stop({ loopId: 'loop_1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC service unavailable');
      expect(mockIpcClient.loopStop).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('stops the loop and confirms with the loopId', async () => {
      mockIpcClient.loopStop.mockResolvedValue({ success: true });

      const result = await loop_stop({ loopId: 'loop_1' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('loop_1');
      expect(mockIpcClient.loopStop).toHaveBeenCalledWith('loop_1');
    });
  });

  describe('IPC failure', () => {
    it('surfaces the IPC error when loopStop reports failure', async () => {
      mockIpcClient.loopStop.mockResolvedValue({
        success: false,
        errorType: 'ipc_request_failed',
        error: 'nope',
      });

      const result = await loop_stop({ loopId: 'loop_1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('nope');
    });
  });
});

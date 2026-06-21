/**
 * Tests for loop_status tool (packages/mcp-server/src/tools/loop-status.ts)
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

import { loop_status } from './loop-status.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  loopStatus: vi.fn(),
};

describe('loop_status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('returns an error when loopId is missing', async () => {
      const result = await loop_status({ loopId: '' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('loopId is required');
      expect(mockIpcClient.loopStatus).not.toHaveBeenCalled();
    });
  });

  describe('IPC availability', () => {
    it('returns an error and does not call IPC when unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);

      const result = await loop_status({ loopId: 'loop_1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC service unavailable');
      expect(mockIpcClient.loopStatus).not.toHaveBeenCalled();
    });
  });

  describe('success path', () => {
    it('reports "not found" when the loop status is absent', async () => {
      mockIpcClient.loopStatus.mockResolvedValue({ success: true, status: undefined });

      const result = await loop_status({ loopId: 'loop_x' });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Loop not found');
    });

    it('formats the status of a running loop', async () => {
      mockIpcClient.loopStatus.mockResolvedValue({
        success: true,
        status: {
          loopId: 'loop_1',
          state: 'running',
          currentStep: 3,
          totalSteps: 10,
          startedAt: '2026-06-21',
        },
      });

      const result = await loop_status({ loopId: 'loop_1' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('running');
      expect(result.message).toContain('3/10');
      expect(mockIpcClient.loopStatus).toHaveBeenCalledWith('loop_1');
    });
  });

  describe('IPC failure', () => {
    it('surfaces a default error when IPC loopStatus reports failure', async () => {
      mockIpcClient.loopStatus.mockResolvedValue({
        success: false,
        errorType: 'ipc_timeout',
      });

      const result = await loop_status({ loopId: 'loop_1' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to get loop status');
    });
  });
});

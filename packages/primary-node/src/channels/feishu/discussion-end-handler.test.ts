/**
 * Tests for DiscussionEndHandler — group dissolution via lark-cli.
 *
 * Issue #1229: Smart session end — dissolve group when discussion ends
 *
 * Tests cover:
 * - Successful dissolution via lark-cli
 * - lark-cli not found (ENOENT)
 * - lark-cli timeout
 * - lark-cli returns error
 * - Empty chatId handling
 * - handleDiscussionEnd logging
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dissolveChat, handleDiscussionEnd } from './discussion-end-handler.js';

// ─── Mock Logger ────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

// ─── Mock execFile ─────────────────────────────────────────────────────────

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('DiscussionEndHandler — Issue #1229', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('dissolveChat', () => {
    it('should call lark-cli with correct API path', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        expect(cmd).toBe('lark-cli');
        expect(args).toEqual(['api', 'DELETE /open-apis/im/v1/chats/oc_test123']);
        callback(null, 'success', '');
      });

      const result = await dissolveChat('oc_test123');

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_test123');
    });

    it('should return error for empty chatId', async () => {
      const result = await dissolveChat('');

      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should handle lark-cli not found (ENOENT)', async () => {
      const enoentError = new Error('spawn lark-cli ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';

      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(enoentError, '', '');
      });

      const result = await dissolveChat('oc_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('lark-cli not found');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle lark-cli timeout', async () => {
      const timeoutError = new Error('Command timed out') as NodeJS.ErrnoException;
      timeoutError.killed = true;

      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(timeoutError, '', '');
      });

      const result = await dissolveChat('oc_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('lark-cli timed out');
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should handle lark-cli generic error', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(new Error('Permission denied'), '', 'stderr output');
      });

      const result = await dissolveChat('oc_test123');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Permission denied');
    });

    it('should pass timeout option to execFile', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        expect(opts.timeout).toBe(30000);
        callback(null, 'ok', '');
      });

      await dissolveChat('oc_test123');

      expect(mockExecFile).toHaveBeenCalled();
    });
  });

  describe('handleDiscussionEnd', () => {
    it('should log and call dissolveChat on trigger', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(null, 'success', '');
      });

      const trigger = { phrase: '[DISCUSSION_END]', reason: undefined };
      await handleDiscussionEnd('oc_test123', trigger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test123', phrase: '[DISCUSSION_END]' }),
        'Processing discussion-end trigger'
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test123' }),
        'Discussion ended: group chat dissolved'
      );
    });

    it('should log warning when dissolution fails', async () => {
      const enoentError = new Error('spawn lark-cli ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';

      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(enoentError, '', '');
      });

      const trigger = { phrase: '[DISCUSSION_END:timeout]', reason: 'timeout' };
      await handleDiscussionEnd('oc_test123', trigger);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test123', reason: 'timeout' }),
        'Discussion end trigger detected but failed to dissolve group chat'
      );
    });

    it('should log summary info when trigger has summary', async () => {
      mockExecFile.mockImplementation((cmd, args, opts, callback) => {
        callback(null, 'success', '');
      });

      const trigger = { phrase: '[DISCUSSION_END:summary=Done]', reason: 'summary', summary: 'Done' };
      await handleDiscussionEnd('oc_test123', trigger);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ hasSummary: true, reason: 'summary' }),
        'Processing discussion-end trigger'
      );
    });
  });
});

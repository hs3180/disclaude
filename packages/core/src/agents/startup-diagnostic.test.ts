/**
 * Tests for startup diagnostic module (Issue #2920).
 *
 * @module agents/startup-diagnostic.test
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeStartupFailure,
  formatStartupFailureMessage,
  STARTUP_FAILURE_WINDOW_MS,
  type StartupFailureDetail,
} from './startup-diagnostic.js';

describe('startup-diagnostic', () => {
  describe('STARTUP_FAILURE_WINDOW_MS', () => {
    it('should be 15000ms', () => {
      expect(STARTUP_FAILURE_WINDOW_MS).toBe(15_000);
    });
  });

  describe('analyzeStartupFailure', () => {
    describe('non-startup failures', () => {
      it('should detect non-startup failure when messageCount > 1', () => {
        const detail = analyzeStartupFailure(
          new Error('Something went wrong'),
          5,  // 5 messages received
          60_000,  // 1 minute elapsed
        );

        expect(detail.isStartupFailure).toBe(false);
        expect(detail.category).toBe('unknown');
        expect(detail.description).toBe('');
        expect(detail.suggestion).toBe('');
      });

      it('should detect non-startup failure when elapsed time exceeds window', () => {
        const detail = analyzeStartupFailure(
          new Error('Something went wrong'),
          1,  // 1 message
          30_000,  // 30 seconds elapsed (exceeds 15s window)
        );

        expect(detail.isStartupFailure).toBe(false);
      });
    });

    describe('startup failures with messageCount === 0', () => {
      it('should detect startup failure when no messages received', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 1'),
          0,
          2_000,
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('process_exit');
        expect(detail.description).toBe('Agent 进程异常退出');
      });

      it('should detect startup failure regardless of elapsed time when messageCount is 0', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 1'),
          0,
          120_000,  // 2 minutes elapsed but no messages
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('process_exit');
      });

      it('should detect spawn ENOENT errors', () => {
        const detail = analyzeStartupFailure(
          new Error('spawn ENOENT: command "nonexistent" not found'),
          0,
          500,
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('command_not_found');
        expect(detail.description).toBe('命令或程序未找到');
      });

      it('should detect EACCES permission errors', () => {
        const detail = analyzeStartupFailure(
          new Error('EACCES: permission denied'),
          0,
          500,
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('permission_denied');
      });

      it('should detect generic startup failure for unrecognized errors', () => {
        const detail = analyzeStartupFailure(
          new Error('Unknown startup error'),
          0,
          1_000,
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('process_exit');
        expect(detail.description).toContain('未产生任何消息');
      });

      it('should handle non-Error objects', () => {
        const detail = analyzeStartupFailure(
          'string error message',
          0,
          1_000,
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.originalMessage).toBe('string error message');
      });
    });

    describe('startup failures with low messageCount within window', () => {
      it('should detect startup failure when messageCount is 1 and within window', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 1'),
          1,
          5_000,  // Within 15s window
        );

        expect(detail.isStartupFailure).toBe(true);
        expect(detail.category).toBe('process_exit');
      });

      it('should NOT detect startup failure when messageCount is 2 even within window', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 1'),
          2,
          5_000,
        );

        expect(detail.isStartupFailure).toBe(false);
      });
    });

    describe('exit code specific suggestions', () => {
      it('should provide specific suggestion for exit code 1', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 1'),
          0,
          2_000,
        );

        expect(detail.suggestion).toContain('MCP 配置错误');
        expect(detail.suggestion).toContain('API Key');
      });

      it('should provide specific suggestion for exit code 137 (OOM)', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 137'),
          0,
          2_000,
        );

        expect(detail.suggestion).toContain('内存不足');
      });

      it('should provide specific suggestion for exit code 126 (permission)', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 126'),
          0,
          2_000,
        );

        expect(detail.suggestion).toContain('权限');
      });

      it('should provide generic suggestion for unknown exit code', () => {
        const detail = analyzeStartupFailure(
          new Error('Claude Code process exited with code 42'),
          0,
          2_000,
        );

        expect(detail.suggestion).toContain('MCP 服务器配置');
        expect(detail.suggestion).toContain('API Key');
      });
    });

    describe('ENOENT specific suggestions', () => {
      it('should suggest checking MCP server command', () => {
        const detail = analyzeStartupFailure(
          new Error('spawn ENOENT: command not found'),
          0,
          500,
        );

        expect(detail.suggestion).toContain('command 字段');
        expect(detail.suggestion).toContain('mcpServers');
      });
    });

    describe('detail properties', () => {
      it('should include original error message', () => {
        const detail = analyzeStartupFailure(
          new Error('My specific error'),
          0,
          1_000,
        );

        expect(detail.originalMessage).toBe('My specific error');
      });

      it('should include elapsed time', () => {
        const detail = analyzeStartupFailure(
          new Error('Error'),
          0,
          3_500,
        );

        expect(detail.elapsedMs).toBe(3_500);
      });

      it('should include message count', () => {
        const detail = analyzeStartupFailure(
          new Error('Error'),
          0,
          1_000,
        );

        expect(detail.messageCount).toBe(0);
      });
    });
  });

  describe('formatStartupFailureMessage', () => {
    it('should format a complete startup failure message', () => {
      const detail: StartupFailureDetail = {
        isStartupFailure: true,
        category: 'process_exit',
        description: 'Agent 进程异常退出',
        suggestion: '请检查 MCP 配置',
        originalMessage: 'exited with code 1',
        elapsedMs: 2_000,
        messageCount: 0,
      };

      const message = formatStartupFailureMessage(detail);

      expect(message).toContain('❌ Agent 启动失败: Agent 进程异常退出');
      expect(message).toContain('💡 请检查 MCP 配置');
      expect(message).toContain('🔧 原始错误: exited with code 1');
      expect(message).toContain('/reset');
    });

    it('should handle missing suggestion gracefully', () => {
      const detail: StartupFailureDetail = {
        isStartupFailure: true,
        category: 'unknown',
        description: 'Unknown failure',
        suggestion: '',
        originalMessage: 'some error',
        elapsedMs: 1_000,
        messageCount: 0,
      };

      const message = formatStartupFailureMessage(detail);

      expect(message).not.toContain('💡');
      expect(message).toContain('🔧 原始错误: some error');
    });
  });
});

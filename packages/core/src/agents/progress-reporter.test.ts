/**
 * Tests for ProgressReporter.
 *
 * Issue #857: Task progress reporting for running subagents.
 *
 * @module agents/progress-reporter.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressReporter, type SendCardCallback } from './progress-reporter.js';

describe('ProgressReporter', () => {
  let sendCard: SendCardCallback;
  let reporter: ProgressReporter;
  let sentCards: Array<{ chatId: string; card: Record<string, unknown>; description?: string }>;

  beforeEach(() => {
    sentCards = [];
    sendCard = vi.fn((chatId: string, card: Record<string, unknown>, description?: string) => {
      sentCards.push({ chatId, card, description });
      return Promise.resolve();
    });
    reporter = new ProgressReporter({
      sendCard,
      reportIntervalMs: 100, // Short interval for tests
    });
  });

  afterEach(() => {
    reporter.dispose();
  });

  describe('startTracking', () => {
    it('should send an initial progress card', () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');

      expect(sendCard).toHaveBeenCalledTimes(1);
      expect(sentCards[0].chatId).toBe('chat-123');

      const card = sentCards[0].card as { header: { title: { content: string } } };
      expect(card.header.title.content).toContain('任务执行中');
    });

    it('should not double-track the same agent', () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');
      reporter.startTracking('agent-1', 'chat-123', 'test-task');

      expect(sendCard).toHaveBeenCalledTimes(1);
    });

    it('should track multiple agents independently', () => {
      reporter.startTracking('agent-1', 'chat-123', 'task-1');
      reporter.startTracking('agent-2', 'chat-456', 'task-2');

      expect(sendCard).toHaveBeenCalledTimes(2);
      expect(sentCards[0].chatId).toBe('chat-123');
      expect(sentCards[1].chatId).toBe('chat-456');
    });
  });

  describe('stopTracking', () => {
    it('should send a final card with completed status', async () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');

      // Clear initial card and mock call count
      sentCards.length = 0;
      vi.mocked(sendCard).mockClear();

      await reporter.stopTracking('agent-1', 'completed');

      expect(sendCard).toHaveBeenCalledTimes(1);
      const card = sentCards[0].card as { header: { title: { content: string }; template: string } };
      expect(card.header.title.content).toContain('任务完成');
      expect(card.header.template).toBe('green');
    });

    it('should send a final card with failed status', async () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');
      sentCards.length = 0;
      vi.mocked(sendCard).mockClear();

      await reporter.stopTracking('agent-1', 'failed');

      const card = sentCards[0].card as { header: { title: { content: string }; template: string } };
      expect(card.header.title.content).toContain('任务失败');
      expect(card.header.template).toBe('red');
    });

    it('should send a final card with stopped status', async () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');
      sentCards.length = 0;
      vi.mocked(sendCard).mockClear();

      await reporter.stopTracking('agent-1', 'stopped');

      const card = sentCards[0].card as { header: { title: { content: string }; template: string } };
      expect(card.header.title.content).toContain('任务停止');
      expect(card.header.template).toBe('grey');
    });

    it('should handle stopping an untracked agent gracefully', async () => {
      await expect(reporter.stopTracking('unknown', 'completed')).resolves.toBeUndefined();
      expect(sendCard).not.toHaveBeenCalled();
    });
  });

  describe('periodic reporting', () => {
    it('should send periodic progress cards', async () => {
      vi.useFakeTimers();

      const reporterWithTimer = new ProgressReporter({
        sendCard,
        reportIntervalMs: 100,
      });

      reporterWithTimer.startTracking('agent-1', 'chat-123', 'test-task');

      // Initial card
      expect(sendCard).toHaveBeenCalledTimes(1);

      // Advance past first interval
      await vi.advanceTimersByTimeAsync(150);

      expect(sendCard).toHaveBeenCalledTimes(2);

      // Advance past second interval
      await vi.advanceTimersByTimeAsync(100);

      expect(sendCard).toHaveBeenCalledTimes(3);

      // Stop tracking
      await reporterWithTimer.stopTracking('agent-1', 'completed');

      // Final card sent
      expect(sendCard).toHaveBeenCalledTimes(4);

      // Advance more — no more cards
      await vi.advanceTimersByTimeAsync(200);

      expect(sendCard).toHaveBeenCalledTimes(4);

      reporterWithTimer.dispose();
      vi.useRealTimers();
    });
  });

  describe('updateStatus', () => {
    it('should update status for a tracked agent', () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');

      reporter.updateStatus('agent-1', 'running');

      const progress = reporter.getProgress('agent-1');
      expect(progress?.status).toBe('running');
    });

    it('should handle updating an untracked agent gracefully', () => {
      expect(() => reporter.updateStatus('unknown', 'running')).not.toThrow();
    });
  });

  describe('getProgress', () => {
    it('should return progress info for a tracked agent', () => {
      reporter.startTracking('agent-1', 'chat-123', 'test-task');

      const progress = reporter.getProgress('agent-1');
      expect(progress).toBeDefined();
      expect(progress?.agentId).toBe('agent-1');
      expect(progress?.name).toBe('test-task');
      expect(progress?.chatId).toBe('chat-123');
      expect(progress?.status).toBe('starting');
      expect(progress?.elapsed).toBeGreaterThanOrEqual(0);
      expect(progress?.reportCount).toBe(1); // Initial card
    });

    it('should return undefined for an untracked agent', () => {
      expect(reporter.getProgress('unknown')).toBeUndefined();
    });
  });

  describe('getAllProgress', () => {
    it('should return all tracked agents', () => {
      reporter.startTracking('agent-1', 'chat-123', 'task-1');
      reporter.startTracking('agent-2', 'chat-456', 'task-2');

      const allProgress = reporter.getAllProgress();
      expect(allProgress).toHaveLength(2);
      expect(allProgress.map(p => p.agentId)).toContain('agent-1');
      expect(allProgress.map(p => p.agentId)).toContain('agent-2');
    });
  });

  describe('dispose', () => {
    it('should stop all timers and clear tracking', () => {
      reporter.startTracking('agent-1', 'chat-123', 'task-1');
      reporter.startTracking('agent-2', 'chat-456', 'task-2');

      reporter.dispose();

      expect(reporter.getAllProgress()).toHaveLength(0);
      expect(reporter.getProgress('agent-1')).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should handle sendCard errors gracefully', async () => {
      const failingSendCard = vi.fn(() => {
        return Promise.reject(new Error('Network error'));
      });
      const failingReporter = new ProgressReporter({
        sendCard: failingSendCard,
        reportIntervalMs: 100,
      });

      // Should not throw
      failingReporter.startTracking('agent-1', 'chat-123', 'test-task');
      await failingReporter.stopTracking('agent-1', 'failed');

      failingReporter.dispose();
    });
  });
});

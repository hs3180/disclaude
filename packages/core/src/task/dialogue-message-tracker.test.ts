/**
 * Unit tests for DialogueMessageTracker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';

describe('DialogueMessageTracker', () => {
  let tracker: DialogueMessageTracker;

  beforeEach(() => {
    tracker = new DialogueMessageTracker();
  });

  describe('constructor', () => {
    it('should create a tracker with no messages sent', () => {
      expect(tracker.hasAnyMessage()).toBe(false);
    });
  });

  describe('recordMessageSent', () => {
    it('should mark that a message was sent', () => {
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });

    it('should remain true after multiple calls', () => {
      tracker.recordMessageSent();
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });
  });

  describe('hasAnyMessage', () => {
    it('should return false initially', () => {
      expect(tracker.hasAnyMessage()).toBe(false);
    });

    it('should return true after recording a message', () => {
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset tracking state', () => {
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);

      tracker.reset();
      expect(tracker.hasAnyMessage()).toBe(false);
    });

    it('should be safe to call multiple times', () => {
      tracker.reset();
      tracker.reset();
      expect(tracker.hasAnyMessage()).toBe(false);
    });
  });

  describe('buildWarning', () => {
    it('should build warning with reason', () => {
      const warning = tracker.buildWarning('task_done');
      expect(warning).toContain('任务完成但无反馈消息');
      expect(warning).toContain('结束原因: task_done');
    });

    it('should include taskId when provided', () => {
      const warning = tracker.buildWarning('max_iterations', 'task-123');
      expect(warning).toContain('任务 ID: task-123');
    });

    it('should not include taskId when not provided', () => {
      const warning = tracker.buildWarning('error');
      expect(warning).not.toContain('任务 ID:');
    });

    it('should include possible causes', () => {
      const warning = tracker.buildWarning('task_done');
      expect(warning).toContain('Agent 没有生成任何输出');
      expect(warning).toContain('所有消息都通过内部工具处理');
      expect(warning).toContain('可能存在配置问题');
    });

    it('should handle different reason types', () => {
      const reasons = ['task_done', 'max_iterations', 'error', 'timeout', 'cancelled'];
      for (const reason of reasons) {
        const warning = tracker.buildWarning(reason);
        expect(warning).toContain(`结束原因: ${reason}`);
      }
    });
  });
});

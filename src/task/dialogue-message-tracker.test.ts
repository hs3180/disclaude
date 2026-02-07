/**
 * Tests for DialogueMessageTracker.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DialogueMessageTracker } from './dialogue-message-tracker.js';

describe('DialogueMessageTracker', () => {
  let tracker: DialogueMessageTracker;

  beforeEach(() => {
    tracker = new DialogueMessageTracker();
  });

  describe('initial state', () => {
    it('should start with no messages sent', () => {
      expect(tracker.hasAnyMessage()).toBe(false);
    });
  });

  describe('recordMessageSent', () => {
    it('should mark message as sent', () => {
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });

    it('should remain true after multiple records', () => {
      tracker.recordMessageSent();
      tracker.recordMessageSent();
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);
    });
  });

  describe('reset', () => {
    it('should reset message sent state', () => {
      tracker.recordMessageSent();
      expect(tracker.hasAnyMessage()).toBe(true);

      tracker.reset();
      expect(tracker.hasAnyMessage()).toBe(false);
    });

    it('should be idempotent', () => {
      tracker.reset();
      tracker.reset();
      expect(tracker.hasAnyMessage()).toBe(false);
    });
  });

  describe('buildWarning', () => {
    it('should build warning with reason only', () => {
      const warning = tracker.buildWarning('task_done');

      expect(warning).toContain('任务完成但无反馈消息');
      expect(warning).toContain('结束原因: task_done');
      expect(warning).toContain('这可能表示:');
    });

    it('should build warning with reason and taskId', () => {
      const warning = tracker.buildWarning('max_iterations', 'task-123');

      expect(warning).toContain('任务完成但无反馈消息');
      expect(warning).toContain('结束原因: max_iterations');
      expect(warning).toContain('任务 ID: task-123');
    });

    it('should include possible causes', () => {
      const warning = tracker.buildWarning('error');

      expect(warning).toContain('- Agent 没有生成任何输出');
      expect(warning).toContain('- 所有消息都通过内部工具处理');
      expect(warning).toContain('- 可能存在配置问题');
    });
  });
});

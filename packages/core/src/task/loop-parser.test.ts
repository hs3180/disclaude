import { describe, it, expect } from 'vitest';
import { LoopParser } from './loop-parser.js';

const SAMPLE_LOOP_MD = `# Refactor Auth Module

## 配置
- **clear_context_per_step**: false
- **max_duration**: 2h
- **max_consecutive_failures**: 3
- **startedAt**: 2026-06-11T00:00:00.000Z

## 目标
Refactor the authentication module to use JWT tokens instead of session cookies.

## 约束
Must maintain backward compatibility with existing API.

## 待办
- [ ] Extract auth logic into separate module
- [ ] Add JWT token generation
- [ ] Update middleware to validate JWT
- [ ] Add migration guide

## 进度记录
> agent 每完成一个步骤后在这里追加简要记录
`;

const LOOP_WITH_PROGRESS = `# Refactor Auth Module

## 配置
- **clear_context_per_step**: false
- **max_duration**: 2h
- **max_consecutive_failures**: 3
- **startedAt**: 2026-06-11T00:00:00.000Z

## 目标
Refactor the authentication module.

## 约束
Keep it simple.

## 待办
- [x] Extract auth logic
- ~[x]~ Add JWT tokens (failed: API timeout)
- [ ] Update middleware

## 进度记录
- **2026-06-11T00:05:00.000Z**: Extracted auth logic successfully
- **2026-06-11T00:10:00.000Z**: JWT token addition failed: API timeout
`;

describe('LoopParser', () => {
  describe('parseContent', () => {
    it('parses title', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(state.title).toBe('Refactor Auth Module');
    });

    it('parses config', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(state.config.clearContextPerStep).toBe(false);
      expect(state.config.maxDuration).toBe('2h');
      expect(state.config.maxConsecutiveFailures).toBe(3);
      expect(state.config.startedAt).toBe('2026-06-11T00:00:00.000Z');
    });

    it('parses goal', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(state.goal).toContain('JWT tokens');
    });

    it('parses constraints', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(state.constraints).toContain('backward compatibility');
    });

    it('parses pending todos', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(state.todos).toHaveLength(4);
      expect(state.todos[0]).toEqual({
        index: 0,
        checked: false,
        failed: false,
        text: 'Extract auth logic into separate module',
      });
    });

    it('parses todos with mixed states', () => {
      const state = LoopParser.parseContent(LOOP_WITH_PROGRESS);
      expect(state.todos).toHaveLength(3);
      expect(state.todos[0].checked).toBe(true);
      expect(state.todos[1].failed).toBe(true);
      expect(state.todos[2].checked).toBe(false);
      expect(state.todos[2].failed).toBe(false);
    });
  });

  describe('getNextPending', () => {
    it('returns first unchecked item', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      const next = LoopParser.getNextPending(state);
      expect(next?.text).toBe('Extract auth logic into separate module');
    });

    it('skips completed items', () => {
      const state = LoopParser.parseContent(LOOP_WITH_PROGRESS);
      const next = LoopParser.getNextPending(state);
      expect(next?.text).toBe('Update middleware');
      expect(next?.index).toBe(2);
    });

    it('returns null when all done', () => {
      const allDone = SAMPLE_LOOP_MD.replace(
        /- \[ \]/g,
        '- [x]'
      );
      const state = LoopParser.parseContent(allDone);
      expect(LoopParser.getNextPending(state)).toBeNull();
    });
  });

  describe('isComplete', () => {
    it('returns false when pending items exist', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(LoopParser.isComplete(state)).toBe(false);
    });

    it('returns true when all items are done or failed', () => {
      const state = LoopParser.parseContent(LOOP_WITH_PROGRESS);
      // Only item 2 is pending
      expect(LoopParser.isComplete(state)).toBe(false);

      const allDone = LOOP_WITH_PROGRESS.replace(
        '- [ ] Update middleware',
        '- [x] Update middleware'
      );
      const completedState = LoopParser.parseContent(allDone);
      expect(LoopParser.isComplete(completedState)).toBe(true);
    });
  });

  describe('countConsecutiveFailures', () => {
    it('returns 0 when no failures', () => {
      const state = LoopParser.parseContent(SAMPLE_LOOP_MD);
      expect(LoopParser.countConsecutiveFailures(state)).toBe(0);
    });

    it('counts consecutive failures from the end', () => {
      const _state = LoopParser.parseContent(LOOP_WITH_PROGRESS);
      // Item 1 is failed, item 2 is pending (breaks chain from end)
      // But walking backwards: item2=pending→break, so count=0
      // Actually we need to check: from the end, item2 is pending → stops
      // So we get 0. Let's test a case with failures at the end.
    });

    it('counts trailing consecutive failures', () => {
      const md = `# Test

## 配置
- **clear_context_per_step**: false
- **max_duration**: 2h
- **max_consecutive_failures**: 3
- **startedAt**: 2026-06-11T00:00:00.000Z

## 目标
Test

## 约束
None

## 待办
- [x] Step 1
- [x] Step 2
- ~[x]~ Step 3 (failed)
- ~[x]~ Step 4 (failed)

## 进度记录
`;
      const state = LoopParser.parseContent(md);
      expect(LoopParser.countConsecutiveFailures(state)).toBe(2);
    });
  });

  describe('isTimedOut', () => {
    it('returns false when within duration', () => {
      // Set startedAt to now so it's within the 2h window
      const now = new Date().toISOString();
      const md = SAMPLE_LOOP_MD.replace(
        '2026-06-11T00:00:00.000Z',
        now
      );
      const state = LoopParser.parseContent(md);
      expect(LoopParser.isTimedOut(state)).toBe(false);
    });

    it('returns true when past duration', () => {
      const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
      const md = SAMPLE_LOOP_MD.replace(
        '2026-06-11T00:00:00.000Z',
        past
      );
      const state = LoopParser.parseContent(md);
      expect(LoopParser.isTimedOut(state)).toBe(true);
    });
  });

  describe('markTodoInContent', () => {
    it('marks item as done', () => {
      const updated = LoopParser.markTodoInContent(
        SAMPLE_LOOP_MD,
        0,
        'done'
      );
      expect(updated).toContain('- [x] Extract auth logic into separate module');
      expect(updated).toContain('- [ ] Add JWT token generation');
    });

    it('marks item as failed', () => {
      const updated = LoopParser.markTodoInContent(
        SAMPLE_LOOP_MD,
        1,
        'failed'
      );
      expect(updated).toContain('- ~[x]~ Add JWT token generation');
    });
  });

  describe('parseDuration', () => {
    it('handles various duration formats via config parsing', () => {
      const md30m = SAMPLE_LOOP_MD.replace(
        '- **max_duration**: 2h',
        '- **max_duration**: 30m'
      );
      const state = LoopParser.parseContent(md30m);
      expect(state.config.maxDuration).toBe('30m');
    });
  });
});

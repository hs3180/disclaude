import { describe, it, expect } from 'vitest';
import {
  parseLoopMd,
  isLoopComplete,
  getTodoStats,
} from './loop-md-parser';

const SAMPLE_LOOP_MD = `# Test Task

## 配置
- **clear_context_per_step**: false
- **max_duration**: 2h
- **max_consecutive_failures**: 3

## 目标
Build a hello world app.

## 约束
Must use TypeScript.

## 待办
- [x] Step 1: Setup project
- ~[x]~ Step 2: API call (failed: timeout)
- [ ] Step 3: Write tests
- [ ] Step 4: Deploy

## 进度记录
> Step 1 completed successfully.
> Step 2 failed due to timeout.
`;

const MINIMAL_LOOP_MD = `# Simple Loop

## 待办
- [ ] Do something
`;

describe('parseLoopMd', () => {
  it('parses title from H1', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.title).toBe('Test Task');
  });

  it('parses config section', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.config.clearContextPerStep).toBe(false);
    expect(parsed.config.maxDuration).toBe('2h');
    expect(parsed.config.maxConsecutiveFailures).toBe(3);
  });

  it('defaults clearContextPerStep to false when not specified', () => {
    const parsed = parseLoopMd(MINIMAL_LOOP_MD);
    expect(parsed.config.clearContextPerStep).toBe(false);
  });

  it('parses goal section', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.goal).toContain('Build a hello world app');
  });

  it('parses constraints section', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.constraints).toContain('TypeScript');
  });

  it('parses all todo items with correct statuses', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.todos).toHaveLength(4);

    expect(parsed.todos[0].text).toBe('Step 1: Setup project');
    expect(parsed.todos[0].status).toBe('completed');

    expect(parsed.todos[1].text).toBe('Step 2: API call');
    expect(parsed.todos[1].status).toBe('failed');
    expect(parsed.todos[1].note).toBe('failed: timeout');

    expect(parsed.todos[2].text).toBe('Step 3: Write tests');
    expect(parsed.todos[2].status).toBe('pending');

    expect(parsed.todos[3].text).toBe('Step 4: Deploy');
    expect(parsed.todos[3].status).toBe('pending');
  });

  it('parses progress section', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(parsed.progress).toContain('Step 1 completed');
  });

  it('handles empty sections gracefully', () => {
    const parsed = parseLoopMd('# Empty\n');
    expect(parsed.title).toBe('Empty');
    expect(parsed.todos).toEqual([]);
    expect(parsed.goal).toBe('');
    expect(parsed.constraints).toBe('');
  });

  it('handles failed items without note', () => {
    const md = '# T\n## 待办\n- ~[x]~ Failed step\n';
    const parsed = parseLoopMd(md);
    expect(parsed.todos[0].status).toBe('failed');
    expect(parsed.todos[0].text).toBe('Failed step');
    expect(parsed.todos[0].note).toBeUndefined();
  });

  it('collects unknown sections as extra', () => {
    const md = '# T\n## Custom\nSome content\n';
    const parsed = parseLoopMd(md);
    expect(parsed.extraSections['Custom']).toContain('Some content');
  });

  it('handles clear_context_per_step: true', () => {
    const md = '# T\n## 配置\n- **clear_context_per_step**: true\n';
    const parsed = parseLoopMd(md);
    expect(parsed.config.clearContextPerStep).toBe(true);
  });
});

describe('isLoopComplete', () => {
  it('returns false when there are pending items', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    expect(isLoopComplete(parsed)).toBe(false);
  });

  it('returns true when all items are completed or failed', () => {
    const md = '# T\n## 待办\n- [x] Done\n- ~[x]~ Failed\n';
    const parsed = parseLoopMd(md);
    expect(isLoopComplete(parsed)).toBe(true);
  });

  it('returns false for empty todo list', () => {
    const parsed = parseLoopMd('# Empty\n');
    expect(isLoopComplete(parsed)).toBe(false);
  });
});

describe('getTodoStats', () => {
  it('counts items correctly', () => {
    const parsed = parseLoopMd(SAMPLE_LOOP_MD);
    const stats = getTodoStats(parsed);
    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.pending).toBe(2);
  });

  it('returns zeros for empty todos', () => {
    const parsed = parseLoopMd('# Empty\n');
    const stats = getTodoStats(parsed);
    expect(stats.total).toBe(0);
    expect(stats.pending).toBe(0);
  });
});

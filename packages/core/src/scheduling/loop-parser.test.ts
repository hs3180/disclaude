/**
 * Tests for LOOP.md parser.
 *
 * Issue #4039: Loop System — Ralph Loop based autonomous task execution.
 */

import { describe, it, expect } from 'vitest';
import { parseLoopFile, checkOffItem, appendProgress } from './loop-parser.js';

const SAMPLE_LOOP_MD = `# Research: LLM API Pricing

## 目标

对比主流 LLM API 的定价

## 约束

只对比公开定价

## 待办

- [ ] 收集 OpenAI API 定价数据
- [ ] 收集 Anthropic API 定价数据
- [ ] 收集 Google API 定价数据
- [ ] 对比分析并生成报告

## 进度记录

<!-- agent 在此追加执行记录 -->
`;

describe('parseLoopFile', () => {
  it('should parse title from first heading', () => {
    const result = parseLoopFile(SAMPLE_LOOP_MD);
    expect(result.title).toBe('Research: LLM API Pricing');
  });

  it('should extract all checkbox items', () => {
    const result = parseLoopFile(SAMPLE_LOOP_MD);
    expect(result.total).toBe(4);
    expect(result.items[0].text).toBe('收集 OpenAI API 定价数据');
    expect(result.items[3].text).toBe('对比分析并生成报告');
  });

  it('should detect all items as unchecked initially', () => {
    const result = parseLoopFile(SAMPLE_LOOP_MD);
    expect(result.completed).toBe(0);
    expect(result.allDone).toBe(false);
    expect(result.nextIndex).toBe(0);
  });

  it('should detect partially completed items', () => {
    const content = SAMPLE_LOOP_MD.replace(
      '- [ ] 收集 OpenAI API 定价数据',
      '- [x] 收集 OpenAI API 定价数据'
    );
    const result = parseLoopFile(content);
    expect(result.completed).toBe(1);
    expect(result.nextIndex).toBe(1);
    expect(result.allDone).toBe(false);
  });

  it('should detect all done', () => {
    let content = SAMPLE_LOOP_MD;
    for (let i = 0; i < 4; i++) {
      content = checkOffItem(content, i);
    }
    const result = parseLoopFile(content);
    expect(result.completed).toBe(4);
    expect(result.allDone).toBe(true);
    expect(result.nextIndex).toBe(-1);
  });

  it('should handle empty content', () => {
    const result = parseLoopFile('');
    expect(result.title).toBe('Untitled Loop Task');
    expect(result.total).toBe(0);
    expect(result.allDone).toBe(false);
    expect(result.nextIndex).toBe(-1);
  });

  it('should handle file with no checkboxes', () => {
    const result = parseLoopFile('# Just a title\n\nSome text\n');
    expect(result.total).toBe(0);
    expect(result.allDone).toBe(false);
  });
});

describe('checkOffItem', () => {
  it('should check off the specified item', () => {
    const updated = checkOffItem(SAMPLE_LOOP_MD, 0);
    expect(updated).toContain('- [x] 收集 OpenAI API 定价数据');
    expect(updated).toContain('- [ ] 收集 Anthropic API 定价数据');
  });

  it('should check off a middle item', () => {
    const updated = checkOffItem(SAMPLE_LOOP_MD, 2);
    expect(updated).toContain('- [ ] 收集 OpenAI API 定价数据');
    expect(updated).toContain('- [x] 收集 Google API 定价数据');
    expect(updated).toContain('- [ ] 对比分析并生成报告');
  });

  it('should return original for out-of-range index', () => {
    const updated = checkOffItem(SAMPLE_LOOP_MD, 99);
    expect(updated).toBe(SAMPLE_LOOP_MD);
  });

  it('should handle already-checked item gracefully', () => {
    let content = checkOffItem(SAMPLE_LOOP_MD, 0);
    content = checkOffItem(content, 0); // check again
    expect(content).toContain('- [x] 收集 OpenAI API 定价数据');
  });
});

describe('appendProgress', () => {
  it('should append progress entry after progress section', () => {
    const updated = appendProgress(SAMPLE_LOOP_MD, '完成 OpenAI 定价收集');
    expect(updated).toContain('> 20');
    expect(updated).toContain('完成 OpenAI 定价收集');
  });

  it('should create progress section if missing', () => {
    const content = '# Simple Task\n\n- [ ] Do something\n';
    const updated = appendProgress(content, 'Started');
    expect(updated).toContain('## 进度记录');
    expect(updated).toContain('Started');
  });

  it('should include timestamp in progress entry', () => {
    const updated = appendProgress(SAMPLE_LOOP_MD, 'Test message');
    const datePrefix = new Date().toISOString().substring(0, 10);
    expect(updated).toContain(datePrefix);
  });
});

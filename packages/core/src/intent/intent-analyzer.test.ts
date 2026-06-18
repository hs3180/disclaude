/**
 * Tests for the Intent module — intent-analyzer
 * Related: #4152
 */

import { describe, it, expect } from 'vitest';
import { analyzeIntent } from './intent-analyzer.js';

describe('analyzeIntent', () => {
  it('detects parse request as data processing', () => {
    const result = analyzeIntent('帮我解析这个CSV文件');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.needsConvergence).toBe(true);
    expect(result.dataHints).toContain('CSV');
  });

  it('detects summarize request', () => {
    const result = analyzeIntent('统计一下这个月的开支');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.needsConvergence).toBe(true);
  });

  it('detects convert request with format hint', () => {
    const result = analyzeIntent('把JSON转换为YAML格式');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.dataHints).toContain('JSON');
    expect(result.dataHints).toContain('YAML');
  });

  it('detects analyze request', () => {
    const result = analyzeIntent('分析这份Excel报表的数据');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.dataHints).toContain('Excel');
  });

  it('does not flag casual conversation', () => {
    const result = analyzeIntent('你好，今天天气怎么样？');
    expect(result.isDataProcessingTask).toBe(false);
    expect(result.needsConvergence).toBe(false);
  });

  it('does not flag code implementation requests', () => {
    const result = analyzeIntent('帮我写一个Python脚本');
    expect(result.isDataProcessingTask).toBe(false);
  });

  it('detects multiple patterns in one message', () => {
    const result = analyzeIntent('提取PDF中的表格数据并汇总');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.dataHints).toContain('PDF');
  });

  it('provides reason when data processing detected', () => {
    const result = analyzeIntent('清洗这些数据');
    expect(result.reason).toBeTruthy();
  });

  it('provides reason when no data processing detected', () => {
    const result = analyzeIntent('hello');
    expect(result.reason).toContain('No data processing');
  });

  it('detects merge/combine operations', () => {
    const result = analyzeIntent('合并这两个CSV文件');
    expect(result.isDataProcessingTask).toBe(true);
    expect(result.dataHints).toContain('CSV');
  });

  it('detects compare operations', () => {
    const result = analyzeIntent('对比这两个月的销售数据');
    expect(result.isDataProcessingTask).toBe(true);
  });
});

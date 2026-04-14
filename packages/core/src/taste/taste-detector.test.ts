/**
 * Tests for the Taste detector module.
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeCorrection,
  mergeTasteRules,
  scanLogForCorrections,
  buildTastePromptSection,
} from './taste-detector.js';
import { createEmptyTasteData } from './taste-loader.js';
import type { TasteData, DetectedCorrection } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// categorizeCorrection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('categorizeCorrection', () => {
  it('should categorize code style corrections', () => {
    expect(categorizeCorrection('不要用var')).toBe('code_style');
    expect(categorizeCorrection('函数名用camelCase')).toBe('code_style');
    expect(categorizeCorrection('使用const/let')).toBe('code_style');
  });

  it('should categorize tech preference corrections', () => {
    expect(categorizeCorrection('优先使用TypeScript')).toBe('tech_preference');
    expect(categorizeCorrection('用pnpm不要用npm')).toBe('tech_preference');
  });

  it('should categorize interaction corrections', () => {
    expect(categorizeCorrection('回复简洁')).toBe('interaction');
    expect(categorizeCorrection('commit message用中文')).toBe('interaction');
  });

  it('should default to project_norm', () => {
    expect(categorizeCorrection('测试文件放在__tests__目录')).toBe('project_norm');
    expect(categorizeCorrection('something random')).toBe('project_norm');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// mergeTasteRules
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('mergeTasteRules', () => {
  it('should add new rules to empty data', () => {
    const data = createEmptyTasteData();
    const corrections: DetectedCorrection[] = [
      {
        rule: '使用 const/let，禁止 var',
        category: 'code_style',
        example: '不要用var',
        count: 3,
      },
    ];

    const result = mergeTasteRules(data, corrections);
    const keys = Object.keys(result.rules);
    expect(keys).toHaveLength(1);

    const rule = result.rules[keys[0]];
    expect(rule.rule).toBe('使用 const/let，禁止 var');
    expect(rule.category).toBe('code_style');
    expect(rule.source.correctionCount).toBe(3);
    expect(rule.source.origin).toBe('auto');
  });

  it('should increment count for existing rules', () => {
    const data = createEmptyTasteData();
    const correction: DetectedCorrection = {
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      example: '不要用var',
      count: 2,
    };

    // First merge
    const result1 = mergeTasteRules(data, [correction]);
    const [key1] = Object.keys(result1.rules);
    expect(result1.rules[key1].source.correctionCount).toBe(2);

    // Second merge (same rule)
    const correction2: DetectedCorrection = {
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      example: '不要用var',
      count: 1,
    };
    const result2 = mergeTasteRules(result1, [correction2]);
    const [key2] = Object.keys(result2.rules);
    expect(result2.rules[key2].source.correctionCount).toBe(3);
  });

  it('should not mutate the original data', () => {
    const data = createEmptyTasteData();
    const corrections: DetectedCorrection[] = [
      {
        rule: 'test rule',
        category: 'code_style',
        example: 'example',
        count: 1,
      },
    ];

    mergeTasteRules(data, corrections);
    expect(Object.keys(data.rules)).toHaveLength(0);
  });

  it('should update updatedAt timestamp', () => {
    const data: TasteData = {
      version: 1,
      rules: {},
      updatedAt: '2000-01-01T00:00:00Z',
    };

    const result = mergeTasteRules(data, []);
    expect(result.updatedAt > '2000-01-01T00:00:00Z').toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// scanLogForCorrections
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('scanLogForCorrections', () => {
  it('should detect repeated "不要用X" patterns', () => {
    const log = `
## [2026-04-14T09:00:00Z] 📥 User
不要用var

## [2026-04-14T09:01:00Z] 📤 Bot
好的

## [2026-04-14T10:00:00Z] 📥 User
不要用var
`;

    const corrections = scanLogForCorrections(log);
    // "不要用var" appears twice in user messages → should detect
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    expect(corrections.some(c => c.rule.includes('var'))).toBe(true);
  });

  it('should ignore single-occurrence patterns', () => {
    const log = `
## [2026-04-14T09:00:00Z] 📥 User
不要用var
`;

    const corrections = scanLogForCorrections(log);
    expect(corrections).toHaveLength(0);
  });

  it('should return empty for empty logs', () => {
    expect(scanLogForCorrections('')).toHaveLength(0);
    expect(scanLogForCorrections('no user messages here')).toHaveLength(0);
  });

  it('should detect "应该是/应该用" patterns', () => {
    const log = `
## [2026-04-14T09:00:00Z] 📥 User
应该用TypeScript

## [2026-04-14T09:01:00Z] 📤 Bot
好的

## [2026-04-14T10:00:00Z] 📥 User
应该用TypeScript
`;

    const corrections = scanLogForCorrections(log);
    expect(corrections.length).toBeGreaterThanOrEqual(1);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// buildTastePromptSection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('buildTastePromptSection', () => {
  it('should return empty string for empty data', () => {
    const data = createEmptyTasteData();
    expect(buildTastePromptSection(data)).toBe('');
  });

  it('should format rules grouped by category', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        use_const: {
          rule: '使用 const/let，禁止 var',
          category: 'code_style',
          source: { origin: 'auto', correctionCount: 3, lastSeen: '2026-04-14T00:00:00Z' },
        },
        be_concise: {
          rule: '回复简洁，先结论后分析',
          category: 'interaction',
          source: { origin: 'manual', lastSeen: '2026-04-14T00:00:00Z' },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    const result = buildTastePromptSection(data);
    expect(result).toContain('User Taste');
    expect(result).toContain('代码风格');
    expect(result).toContain('交互偏好');
    expect(result).toContain('使用 const/let');
    expect(result).toContain('回复简洁');
    expect(result).toContain('被纠正 3 次');
  });

  it('should sort rules by correction count (descending)', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        rule_a: {
          rule: '规则 A',
          category: 'code_style',
          source: { origin: 'auto', correctionCount: 1, lastSeen: '2026-04-14T00:00:00Z' },
        },
        rule_b: {
          rule: '规则 B',
          category: 'code_style',
          source: { origin: 'auto', correctionCount: 5, lastSeen: '2026-04-14T00:00:00Z' },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    const result = buildTastePromptSection(data);
    const indexA = result.indexOf('规则 A');
    const indexB = result.indexOf('规则 B');
    expect(indexB).toBeLessThan(indexA); // B (5 corrections) should come first
  });

  it('should show CLAUDE.md origin', () => {
    const data: TasteData = {
      version: 1,
      rules: {
        from_md: {
          rule: 'Always use TypeScript',
          category: 'tech_preference',
          source: { origin: 'claude_md', lastSeen: '2026-04-14T00:00:00Z' },
        },
      },
      updatedAt: '2026-04-14T00:00:00Z',
    };

    const result = buildTastePromptSection(data);
    expect(result).toContain('来自 CLAUDE.md');
  });
});

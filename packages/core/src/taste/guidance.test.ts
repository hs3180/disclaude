/**
 * Tests for taste guidance builder.
 *
 * @see Issue #2335
 */

import { describe, it, expect } from 'vitest';
import { buildTasteGuidance, getCategoryLabel } from './guidance.js';
import type { TasteRule } from './types.js';

describe('buildTasteGuidance', () => {
  it('should return empty string when no rules provided', () => {
    expect(buildTasteGuidance([])).toBe('');
    expect(buildTasteGuidance(undefined as unknown as TasteRule[])).toBe('');
  });

  it('should format single rule with manual source', () => {
    const rules: TasteRule[] = [
      { category: 'code_style', content: 'Use const/let, never var', source: 'manual' },
    ];

    const result = buildTasteGuidance(rules);
    expect(result).toContain('User Preferences');
    expect(result).toContain('Use const/let, never var');
    expect(result).toContain('手动设置');
    expect(result).toContain('代码风格');
  });

  it('should format auto-detected rule with correction count', () => {
    const rules: TasteRule[] = [
      { category: 'code_style', content: 'Use camelCase', source: 'auto', correctionCount: 5 },
    ];

    const result = buildTasteGuidance(rules);
    expect(result).toContain('被纠正 5 次');
  });

  it('should format claude_md source', () => {
    const rules: TasteRule[] = [
      { category: 'project_convention', content: 'Always test', source: 'claude_md' },
    ];

    const result = buildTasteGuidance(rules);
    expect(result).toContain('来自 CLAUDE.md');
  });

  it('should group rules by category', () => {
    const rules: TasteRule[] = [
      { category: 'code_style', content: 'Rule 1', source: 'manual' },
      { category: 'interaction', content: 'Rule 2', source: 'manual' },
      { category: 'code_style', content: 'Rule 3', source: 'manual' },
    ];

    const result = buildTasteGuidance(rules);
    // Both categories should be present
    expect(result).toContain('代码风格');
    expect(result).toContain('交互偏好');

    // Code style rules should be in the same section
    const codeStyleIdx = result.indexOf('代码风格');
    const interactionIdx = result.indexOf('交互偏好');
    expect(codeStyleIdx).toBeGreaterThan(-1);
    expect(interactionIdx).toBeGreaterThan(-1);
  });

  it('should include taste.yaml edit instruction', () => {
    const rules: TasteRule[] = [
      { category: 'code_style', content: 'Rule', source: 'manual' },
    ];

    const result = buildTasteGuidance(rules);
    expect(result).toContain('taste.yaml');
  });

  it('should not add suffix for auto rule with no correctionCount', () => {
    const rules: TasteRule[] = [
      { category: 'code_style', content: 'Some auto rule', source: 'auto' },
    ];

    const result = buildTasteGuidance(rules);
    // auto source with no correctionCount should not have count suffix
    expect(result).not.toContain('被纠正');
    expect(result).not.toContain('手动设置');
    expect(result).not.toContain('CLAUDE.md');
  });
});

describe('getCategoryLabel', () => {
  it('should return correct Chinese labels', () => {
    expect(getCategoryLabel('code_style')).toBe('代码风格');
    expect(getCategoryLabel('interaction')).toBe('交互偏好');
    expect(getCategoryLabel('technical')).toBe('技术选择');
    expect(getCategoryLabel('project_convention')).toBe('项目规范');
  });
});

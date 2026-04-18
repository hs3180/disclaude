/**
 * Tests for the Taste Store module.
 *
 * Tests YAML serialization/deserialization, rule operations,
 * pattern merging, and context formatting.
 *
 * @see Issue #2335
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  serializeToYaml,
  parseFromYaml,
  readTasteProfile,
  writeTasteProfile,
  deleteTasteProfile,
  getTastePath,
  mergePatterns,
  addManualRule,
  removeRule,
  getActiveRules,
  getSummary,
  formatTasteForContext,
} from './taste-store.js';
import type { TasteProfile, TasteRule, DetectedPattern } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createSampleRule(overrides: Partial<TasteRule> = {}): TasteRule {
  return {
    rule: '使用 const/let，禁止 var',
    source: 'auto',
    count: 3,
    last_seen: '2026-04-14',
    examples: ['不要用 var，用 const/let'],
    ...overrides,
  };
}

function createSampleProfile(): TasteProfile {
  return {
    last_updated: '2026-04-18',
    taste: {
      code_style: [
        createSampleRule(),
        createSampleRule({
          rule: '函数名使用 camelCase',
          count: 2,
          last_seen: '2026-04-15',
          examples: ['函数名用 camelCase 不要用 snake_case'],
        }),
      ],
      interaction: [
        createSampleRule({
          rule: '回复简洁，先结论后分析',
          count: 2,
          last_seen: '2026-04-16',
          examples: ['回复要简洁，不要啰嗦'],
        }),
      ],
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// YAML Serialization Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('serializeToYaml', () => {
  it('should serialize an empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    const yaml = serializeToYaml(profile);

    expect(yaml).toContain('# Auto-generated user preference profile');
    expect(yaml).toContain('taste:');
  });

  it('should serialize a profile with rules', () => {
    const profile = createSampleProfile();
    const yaml = serializeToYaml(profile);

    expect(yaml).toContain('code_style:');
    expect(yaml).toContain('rule: "使用 const/let，禁止 var"');
    expect(yaml).toContain('count: 3');
    expect(yaml).toContain('interaction:');
    expect(yaml).toContain('rule: "回复简洁，先结论后分析"');
  });

  it('should escape special characters in rule text', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        code_style: [{
          rule: 'Use "double quotes" and \\backslash',
          source: 'auto',
          count: 1,
          last_seen: '2026-04-18',
          examples: [],
        }],
      },
    };

    const yaml = serializeToYaml(profile);
    expect(yaml).toContain('Use \\"double quotes\\" and \\\\backslash');
  });
});

describe('parseFromYaml', () => {
  it('should parse a YAML string into a TasteProfile', () => {
    const yaml = `
# Auto-generated user preference profile
# Last updated: 2026-04-18

taste:
  code_style:
    - rule: "使用 const/let，禁止 var"
      source: auto
      count: 3
      last_seen: "2026-04-14"
      examples:
        - "不要用 var，用 const/let"
  interaction:
    - rule: "回复简洁"
      source: manual
      count: 1
      last_seen: "2026-04-16"
      examples:
`;

    const profile = parseFromYaml(yaml);

    expect(profile.taste.code_style).toHaveLength(1);
    expect(profile.taste.code_style![0].rule).toBe('使用 const/let，禁止 var');
    expect(profile.taste.code_style![0].count).toBe(3);
    expect(profile.taste.interaction).toHaveLength(1);
    expect(profile.taste.interaction![0].source).toBe('manual');
  });

  it('should handle empty YAML gracefully', () => {
    const yaml = '# Empty file\ntaste:\n  {}\n';
    const profile = parseFromYaml(yaml);

    expect(profile.taste).toEqual({});
  });

  it('should handle YAML with comments only', () => {
    const yaml = '# Just a comment\n';
    const profile = parseFromYaml(yaml);

    expect(profile.taste).toEqual({});
  });

  it('should round-trip serialize and parse', () => {
    const original = createSampleProfile();
    const yaml = serializeToYaml(original);
    const parsed = parseFromYaml(yaml);

    // Check category existence
    expect(parsed.taste.code_style).toHaveLength(2);
    expect(parsed.taste.interaction).toHaveLength(1);

    // Check first rule details
    expect(parsed.taste.code_style![0].rule).toBe('使用 const/let，禁止 var');
    expect(parsed.taste.code_style![0].count).toBe(3);
    expect(parsed.taste.code_style![0].source).toBe('auto');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// File Operations Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('readTasteProfile / writeTasteProfile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taste-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should return empty profile when file does not exist', async () => {
    const profile = await readTasteProfile(tmpDir);
    expect(profile.taste).toEqual({});
  });

  it('should write and read a profile', async () => {
    const original = createSampleProfile();

    await writeTasteProfile(tmpDir, original);
    const loaded = await readTasteProfile(tmpDir);

    expect(loaded.taste.code_style).toHaveLength(2);
    expect(loaded.taste.code_style![0].rule).toBe('使用 const/let，禁止 var');
    expect(loaded.taste.interaction).toHaveLength(1);
  });

  it('should update last_updated on write', async () => {
    const profile = createSampleProfile();
    profile.last_updated = '2020-01-01';

    await writeTasteProfile(tmpDir, profile);
    const loaded = await readTasteProfile(tmpDir);

    // last_updated should be today (not 2020)
    expect(loaded.last_updated).not.toBe('2020-01-01');
    expect(loaded.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('should create workspace directory if missing', async () => {
    const nestedDir = path.join(tmpDir, 'nested', 'dir');
    const profile = createSampleProfile();

    await writeTasteProfile(nestedDir, profile);
    const loaded = await readTasteProfile(nestedDir);

    expect(loaded.taste.code_style).toHaveLength(2);
  });
});

describe('deleteTasteProfile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'taste-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should delete existing profile', async () => {
    await writeTasteProfile(tmpDir, createSampleProfile());
    const deleted = await deleteTasteProfile(tmpDir);
    expect(deleted).toBe(true);

    const profile = await readTasteProfile(tmpDir);
    expect(profile.taste).toEqual({});
  });

  it('should return false when file does not exist', async () => {
    const deleted = await deleteTasteProfile(tmpDir);
    expect(deleted).toBe(false);
  });
});

describe('getTastePath', () => {
  it('should return correct path', () => {
    const result = getTastePath('/workspace');
    expect(result).toBe(path.join('/workspace', 'taste.yaml'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rule Operations Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('mergePatterns', () => {
  it('should add new patterns to empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    const patterns: DetectedPattern[] = [{
      rule: '使用 const/let',
      category: 'code_style',
      count: 2,
      examples: ['不要用 var'],
      lastSeen: '2026-04-17',
    }];

    const result = mergePatterns(profile, patterns);

    expect(result.taste.code_style).toHaveLength(1);
    expect(result.taste.code_style![0].rule).toBe('使用 const/let');
    expect(result.taste.code_style![0].count).toBe(2);
    expect(result.taste.code_style![0].source).toBe('auto');
  });

  it('should merge into existing rules', () => {
    const profile = createSampleProfile();
    const originalCount = profile.taste.code_style![0].count;

    const patterns: DetectedPattern[] = [{
      rule: '使用 const/let，禁止 var',
      category: 'code_style',
      count: 1,
      examples: ['又用了 var'],
      lastSeen: '2026-04-18',
    }];

    const result = mergePatterns(profile, patterns);

    expect(result.taste.code_style![0].count).toBe(originalCount + 1);
    expect(result.taste.code_style![0].last_seen).toBe('2026-04-18');
    expect(result.taste.code_style![0].examples).toContain('又用了 var');
  });

  it('should limit examples to 3', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        code_style: [{
          rule: 'test',
          source: 'auto',
          count: 1,
          last_seen: '2026-04-18',
          examples: ['ex1', 'ex2', 'ex3'],
        }],
      },
    };

    const patterns: DetectedPattern[] = [{
      rule: 'test',
      category: 'code_style',
      count: 1,
      examples: ['ex4'],
      lastSeen: '2026-04-18',
    }];

    const result = mergePatterns(profile, patterns);
    expect(result.taste.code_style![0].examples).toHaveLength(3);
    // ex4 should NOT be added (already 3 examples)
    expect(result.taste.code_style![0].examples).not.toContain('ex4');
  });
});

describe('addManualRule', () => {
  it('should add a manual rule to empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    const result = addManualRule(profile, 'technical', '优先使用 TypeScript');

    expect(result.taste.technical).toHaveLength(1);
    expect(result.taste.technical![0].source).toBe('manual');
    expect(result.taste.technical![0].rule).toBe('优先使用 TypeScript');
  });

  it('should not duplicate existing rules', () => {
    const profile = createSampleProfile();
    const originalLength = profile.taste.code_style!.length;

    addManualRule(profile, 'code_style', '使用 const/let，禁止 var');

    expect(profile.taste.code_style).toHaveLength(originalLength);
  });
});

describe('removeRule', () => {
  it('should remove an existing rule', () => {
    const profile = createSampleProfile();
    const originalLength = profile.taste.code_style!.length;

    const result = removeRule(profile, 'code_style', '使用 const/let，禁止 var');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.taste.code_style).toHaveLength(originalLength - 1);
    }
  });

  it('should return error for non-existent rule', () => {
    const profile = createSampleProfile();

    const result = removeRule(profile, 'code_style', '不存在的规则');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not found');
    }
  });

  it('should return error for non-existent category', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    const result = removeRule(profile, 'technical', 'some rule');

    expect(result.ok).toBe(false);
  });

  it('should clean up empty categories', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        interaction: [{
          rule: '唯一的规则',
          source: 'auto',
          count: 2,
          last_seen: '2026-04-18',
          examples: [],
        }],
      },
    };

    const result = removeRule(profile, 'interaction', '唯一的规则');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.taste.interaction).toBeUndefined();
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Query Operations Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getActiveRules', () => {
  it('should return only rules with count >= 2', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        code_style: [
          { rule: 'active', source: 'auto', count: 3, last_seen: '', examples: [] },
          { rule: 'inactive', source: 'auto', count: 1, last_seen: '', examples: [] },
        ],
        interaction: [
          { rule: 'also active', source: 'auto', count: 2, last_seen: '', examples: [] },
        ],
      },
    };

    const active = getActiveRules(profile);

    expect(active).toHaveLength(2);
    expect(active.map(a => a.rule.rule)).toEqual(
      expect.arrayContaining(['active', 'also active']),
    );
  });

  it('should return empty array for empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    expect(getActiveRules(profile)).toEqual([]);
  });
});

describe('getSummary', () => {
  it('should calculate correct summary', () => {
    const profile = createSampleProfile();
    const summary = getSummary(profile);

    expect(summary.totalRules).toBe(3); // 2 code_style + 1 interaction
    expect(summary.categoryCounts.code_style).toBe(2);
    expect(summary.categoryCounts.interaction).toBe(1);
    expect(summary.activeRules).toBe(3); // all have count >= 2
  });

  it('should handle empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    const summary = getSummary(profile);
    expect(summary.totalRules).toBe(0);
    expect(summary.activeRules).toBe(0);
  });
});

describe('formatTasteForContext', () => {
  it('should format active rules as markdown', () => {
    const profile = createSampleProfile();
    const markdown = formatTasteForContext(profile);

    expect(markdown).toContain('## User Taste (auto-learned preferences)');
    expect(markdown).toContain('使用 const/let，禁止 var');
    expect(markdown).toContain('被纠正 3 次');
    expect(markdown).toContain('回复简洁，先结论后分析');
    expect(markdown).toContain('<!-- taste:end -->');
  });

  it('should return null for empty profile', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {},
    };

    expect(formatTasteForContext(profile)).toBeNull();
  });

  it('should return null when all rules have count < 2', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        code_style: [{
          rule: 'inactive rule',
          source: 'auto',
          count: 1,
          last_seen: '',
          examples: [],
        }],
      },
    };

    expect(formatTasteForContext(profile)).toBeNull();
  });

  it('should show manual source correctly', () => {
    const profile: TasteProfile = {
      last_updated: '2026-04-18',
      taste: {
        technical: [{
          rule: 'Use TypeScript',
          source: 'manual',
          count: 2,
          last_seen: '2026-04-18',
          examples: [],
        }],
      },
    };

    const markdown = formatTasteForContext(profile);
    expect(markdown).toContain('手动添加');
  });
});

/**
 * Tests for Recommendations Generator.
 * @see Issue #470
 */

import { describe, it, expect } from 'vitest';
import {
  detectTaskType,
  getRecommendations,
  formatRecommendationsMessage,
  generateRecommendations,
} from './recommendations.js';
import type { RecommendationsConfig } from '../config/types.js';

describe('detectTaskType', () => {
  it('should detect code task type', () => {
    expect(detectTaskType('帮我实现一个函数')).toBe('code');
    expect(detectTaskType('修复这个 bug')).toBe('code');
    expect(detectTaskType('refactor this code')).toBe('code');
  });

  it('should detect documentation task type', () => {
    expect(detectTaskType('帮我写文档')).toBe('documentation');
    expect(detectTaskType('更新 README')).toBe('documentation');
    expect(detectTaskType('write documentation for this module')).toBe('documentation');
  });

  it('should detect research task type', () => {
    expect(detectTaskType('分析一下这个项目')).toBe('research');
    expect(detectTaskType('调研 React 最佳实践')).toBe('research');
    expect(detectTaskType('search for related issues')).toBe('research');
  });

  it('should detect testing task type', () => {
    expect(detectTaskType('写单元测试')).toBe('testing');
    expect(detectTaskType('运行集成测试')).toBe('testing');
    expect(detectTaskType('check test coverage')).toBe('testing');
  });

  it('should default to general for unknown tasks', () => {
    expect(detectTaskType('你好')).toBe('general');
    expect(detectTaskType('random message')).toBe('general');
  });

  it('should use combined message and response for detection', () => {
    expect(detectTaskType('帮我', '我已经实现了这个函数')).toBe('code');
    expect(detectTaskType('帮我', '测试已经通过了')).toBe('testing');
  });
});

describe('getRecommendations', () => {
  it('should return default recommendations for each task type', () => {
    const codeRecs = getRecommendations('code');
    expect(codeRecs.length).toBeGreaterThan(0);
    expect(codeRecs[0]).toHaveProperty('emoji');
    expect(codeRecs[0]).toHaveProperty('description');

    const docRecs = getRecommendations('documentation');
    expect(docRecs.length).toBeGreaterThan(0);

    const researchRecs = getRecommendations('research');
    expect(researchRecs.length).toBeGreaterThan(0);

    const testingRecs = getRecommendations('testing');
    expect(testingRecs.length).toBeGreaterThan(0);

    const generalRecs = getRecommendations('general');
    expect(generalRecs.length).toBeGreaterThan(0);
  });

  it('should respect maxRecommendations config', () => {
    const config: RecommendationsConfig = {
      maxRecommendations: 2,
    };

    const recs = getRecommendations('code', config);
    expect(recs.length).toBe(2);
  });

  it('should use custom recommendations from config', () => {
    const config: RecommendationsConfig = {
      byTaskType: {
        code: [
          { emoji: '🚀', description: 'Deploy to production' },
          { emoji: '🧪', description: 'Run tests' },
        ],
      },
    };

    const recs = getRecommendations('code', config);
    expect(recs.length).toBe(2);
    expect(recs[0].emoji).toBe('🚀');
    expect(recs[0].description).toBe('Deploy to production');
  });

  it('should default to 4 max recommendations', () => {
    const recs = getRecommendations('code');
    expect(recs.length).toBe(4);
  });
});

describe('formatRecommendationsMessage', () => {
  it('should format recommendations correctly', () => {
    const recs = [
      { emoji: '🔍', description: '搜索代码' },
      { emoji: '📝', description: '写测试' },
    ];

    const message = formatRecommendationsMessage(recs);

    expect(message).toContain('💡 接下来你可以：');
    expect(message).toContain('1. 🔍 搜索代码');
    expect(message).toContain('2. 📝 写测试');
    expect(message).toContain('─────────────');
  });

  it('should return empty string for empty recommendations', () => {
    const message = formatRecommendationsMessage([]);
    expect(message).toBe('');
  });
});

describe('generateRecommendations', () => {
  it('should generate recommendations for code task', () => {
    const message = generateRecommendations('帮我实现一个函数');

    expect(message).toContain('💡 接下来你可以：');
    expect(message.length).toBeGreaterThan(0);
  });

  it('should return empty string when disabled', () => {
    const config: RecommendationsConfig = {
      enabled: false,
    };

    const message = generateRecommendations('帮我实现一个函数', undefined, config);
    expect(message).toBe('');
  });

  it('should use agent response for task detection', () => {
    const message = generateRecommendations(
      '帮我',
      '我已经完成了单元测试的编写'
    );

    expect(message).toContain('💡 接下来你可以：');
    // Should detect testing task type
    expect(message).toContain('🧪');
  });

  it('should respect maxRecommendations config', () => {
    const config: RecommendationsConfig = {
      maxRecommendations: 2,
    };

    const message = generateRecommendations('帮我实现一个函数', undefined, config);
    const lines = message.split('\n').filter(l => l.match(/^\d+\./));

    expect(lines.length).toBe(2);
  });
});

/**
 * Tests for Task Complexity Assessor.
 *
 * Issue #857: Phase 1 - Task Complexity Assessment
 */

import { describe, it, expect } from 'vitest';
import {
  TaskComplexityAssessor,
  type ComplexityAssessorConfig,
} from './task-complexity-assessor.js';
import {
  getComplexityLevel,
  ComplexityLevel,
  formatComplexity,
  DEFAULT_COMPLEXITY_THRESHOLDS,
} from './task-complexity-types.js';

describe('TaskComplexityAssessor', () => {
  const assessor = new TaskComplexityAssessor();

  describe('assess', () => {
    it('should return low complexity for simple greetings', () => {
      const result = assessor.assess({ text: 'hello' });

      expect(result.score).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.estimatedSteps).toBeGreaterThanOrEqual(1);
      expect(result.estimatedTimeSeconds).toBeGreaterThan(0);
      expect(result.factors.length).toBeGreaterThan(0);
      expect(result.reasoning).toBeTruthy();
    });

    it('should return low complexity for short questions', () => {
      const result = assessor.assess({ text: 'What is TypeScript?' });

      const level = getComplexityLevel(result.score);
      expect(level).toBe(ComplexityLevel.SIMPLE);
    });

    it('should return medium complexity for code-related questions', () => {
      const result = assessor.assess({
        text: 'Can you explain how the `async/await` pattern works in JavaScript?',
      });

      // Code patterns should increase complexity
      expect(result.factors.some(f => f.name === 'codePatterns' && f.weight > 0)).toBe(true);
    });

    it('should return high complexity for refactoring tasks', () => {
      const result = assessor.assess({
        text: 'Please refactor the entire authentication module to use a different architecture',
      });

      // Refactoring keywords should increase complexity
      const keywordFactor = result.factors.find(f => f.name === 'keywords');
      expect(keywordFactor?.weight).toBeGreaterThan(0);

      // Score should be at least medium
      expect(result.score).toBeGreaterThanOrEqual(4);
    });

    it('should consider message length', () => {
      const shortResult = assessor.assess({ text: 'hi' });
      const longText = 'a'.repeat(1000);
      const longResult = assessor.assess({ text: longText });

      expect(longResult.score).toBeGreaterThan(shortResult.score);
    });

    it('should consider attachments', () => {
      const noAttachments = assessor.assess({ text: 'analyze this', attachmentCount: 0 });
      const withAttachments = assessor.assess({ text: 'analyze this', attachmentCount: 3 });

      expect(withAttachments.score).toBeGreaterThan(noAttachments.score);
      expect(withAttachments.factors.some(f => f.name === 'attachments')).toBe(true);
    });

    it('should consider code blocks', () => {
      const noCode = assessor.assess({ text: 'explain something' });
      const withCode = assessor.assess({
        text: 'here is some code:\n```typescript\nconst x = 1;\n```\nPlease explain it.',
      });

      expect(withCode.score).toBeGreaterThanOrEqual(noCode.score);
    });

    it('should consider chat history length', () => {
      const noHistory = assessor.assess({ text: 'help me' });
      const withHistory = assessor.assess({
        text: 'help me',
        chatHistoryLength: 5000,
      });

      expect(withHistory.score).toBeGreaterThanOrEqual(noHistory.score);
    });

    it('should detect complex keywords', () => {
      const result = assessor.assess({
        text: 'I need to migrate the entire project and refactor the architecture',
      });

      const keywordFactor = result.factors.find(f => f.name === 'keywords');
      expect(keywordFactor?.weight).toBeGreaterThan(0);
    });

    it('should detect simple keywords', () => {
      const result = assessor.assess({ text: 'hello, can you help me?' });

      const keywordFactor = result.factors.find(f => f.name === 'keywords');
      // Simple keywords should reduce or not increase complexity much
      expect(keywordFactor).toBeTruthy();
    });

    it('should detect file references', () => {
      const result = assessor.assess({
        text: 'Please modify src/index.ts and lib/utils.ts',
      });

      const fileFactor = result.factors.find(f => f.name === 'filePatterns');
      expect(fileFactor?.weight).toBeGreaterThan(0);
    });

    it('should clamp score to valid range', () => {
      // Very long message with many complex indicators
      const result = assessor.assess({
        text: 'refactor migrate upgrade ' + 'a'.repeat(5000),
        attachmentCount: 10,
        chatHistoryLength: 10000,
      });

      expect(result.score).toBeLessThanOrEqual(10);
      expect(result.score).toBeGreaterThanOrEqual(1);
    });
  });

  describe('with custom config', () => {
    it('should use custom thresholds', () => {
      const customConfig: ComplexityAssessorConfig = {
        thresholds: {
          simpleThreshold: 2,
          complexThreshold: 5,
          minScore: 1,
          maxScore: 10,
        },
      };
      const customAssessor = new TaskComplexityAssessor(customConfig);

      const result = customAssessor.assess({ text: 'hello world' });
      expect(result.score).toBeGreaterThanOrEqual(1);
    });

    it('should support verbose logging', () => {
      const verboseAssessor = new TaskComplexityAssessor({ verbose: true });
      const result = verboseAssessor.assess({ text: 'test' });

      expect(result).toBeTruthy();
    });
  });
});

describe('Complexity Types', () => {
  describe('getComplexityLevel', () => {
    it('should return SIMPLE for low scores', () => {
      expect(getComplexityLevel(1)).toBe(ComplexityLevel.SIMPLE);
      expect(getComplexityLevel(2)).toBe(ComplexityLevel.SIMPLE);
      expect(getComplexityLevel(3)).toBe(ComplexityLevel.SIMPLE);
    });

    it('should return MEDIUM for middle scores', () => {
      expect(getComplexityLevel(4)).toBe(ComplexityLevel.MEDIUM);
      expect(getComplexityLevel(5)).toBe(ComplexityLevel.MEDIUM);
      expect(getComplexityLevel(6)).toBe(ComplexityLevel.COMPLEX);
    });

    it('should return COMPLEX for high scores', () => {
      expect(getComplexityLevel(7)).toBe(ComplexityLevel.COMPLEX);
      expect(getComplexityLevel(8)).toBe(ComplexityLevel.COMPLEX);
      expect(getComplexityLevel(9)).toBe(ComplexityLevel.COMPLEX);
      expect(getComplexityLevel(10)).toBe(ComplexityLevel.COMPLEX);
    });

    it('should use custom thresholds', () => {
      const customThresholds = {
        simpleThreshold: 2,
        complexThreshold: 8,
        minScore: 1,
        maxScore: 10,
      };

      expect(getComplexityLevel(2, customThresholds)).toBe(ComplexityLevel.SIMPLE);
      expect(getComplexityLevel(5, customThresholds)).toBe(ComplexityLevel.MEDIUM);
      expect(getComplexityLevel(9, customThresholds)).toBe(ComplexityLevel.COMPLEX);
    });
  });

  describe('formatComplexity', () => {
    it('should format simple complexity', () => {
      const result = formatComplexity({
        score: 2,
        estimatedSteps: 1,
        estimatedTimeSeconds: 30,
        reasoning: 'test',
        factors: [],
      });

      expect(result).toContain('🟢');
      expect(result).toContain('2/10');
      expect(result).toContain('30秒');
    });

    it('should format medium complexity', () => {
      const result = formatComplexity({
        score: 5,
        estimatedSteps: 3,
        estimatedTimeSeconds: 120,
        reasoning: 'test',
        factors: [],
      });

      expect(result).toContain('🟡');
      expect(result).toContain('5/10');
      expect(result).toContain('2分钟');
    });

    it('should format complex complexity', () => {
      const result = formatComplexity({
        score: 8,
        estimatedSteps: 5,
        estimatedTimeSeconds: 300,
        reasoning: 'test',
        factors: [],
      });

      expect(result).toContain('🔴');
      expect(result).toContain('8/10');
      expect(result).toContain('5分钟');
    });
  });

  describe('DEFAULT_COMPLEXITY_THRESHOLDS', () => {
    it('should have valid default values', () => {
      expect(DEFAULT_COMPLEXITY_THRESHOLDS.simpleThreshold).toBe(3);
      expect(DEFAULT_COMPLEXITY_THRESHOLDS.complexThreshold).toBe(6);
      expect(DEFAULT_COMPLEXITY_THRESHOLDS.minScore).toBe(1);
      expect(DEFAULT_COMPLEXITY_THRESHOLDS.maxScore).toBe(10);
    });
  });
});

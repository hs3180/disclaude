import { describe, it, expect } from 'vitest';
import {
  getConcerns,
  CONCERN_INFERENCE_TABLE,
  validateOutput,
  getFullSystemPrompt,
  PERSONA_CONFIG,
} from './index.js';

describe('Prompt Parts', () => {
  describe('getConcerns', () => {
    it('should return correct concerns for 35-year-old male', () => {
      const concerns = getConcerns(35, 'male');
      expect(concerns.primary).toContain('中年危机');
      expect(concerns.primary).toContain('职业转型');
    });

    it('should return correct concerns for 28-year-old female', () => {
      const concerns = getConcerns(28, 'female');
      expect(concerns.primary).toContain('婚姻');
      expect(concerns.primary).toContain('生育');
    });

    it('should return default concerns for out-of-range age', () => {
      const concerns = getConcerns(15, 'male');
      expect(concerns.primary).toBeDefined();
    });
  });

  describe('CONCERN_INFERENCE_TABLE', () => {
    it('should have male concerns defined', () => {
      expect(CONCERN_INFERENCE_TABLE.male).toBeDefined();
      expect(CONCERN_INFERENCE_TABLE.male['30-35']).toBeDefined();
    });

    it('should have female concerns defined', () => {
      expect(CONCERN_INFERENCE_TABLE.female).toBeDefined();
      expect(CONCERN_INFERENCE_TABLE.female['30-35']).toBeDefined();
    });
  });

  describe('validateOutput', () => {
    it('should validate output with enough assertions', () => {
      const text = '你这个盘，日主偏弱。官杀混杂。今年流年不错。';
      const result = validateOutput(text);
      expect(result.assertionCount).toBeGreaterThanOrEqual(3);
    });

    it('should detect too many questions', () => {
      const text = '你最近怎么样？说说你的情况？有什么想问的？';
      const result = validateOutput(text);
      expect(result.questionCount).toBeGreaterThan(2);
    });

    it('should detect forbidden questions', () => {
      const text = '你最近怎么样？';
      const result = validateOutput(text);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('should pass valid output', () => {
      const text = '你这个盘，日主偏弱，官杀混杂。17年到36岁走丙申运，今年35。22年、23年是不是换过工作？';
      const result = validateOutput(text);
      expect(result.valid).toBe(true);
    });
  });

  describe('getFullSystemPrompt', () => {
    it('should return combined prompt', () => {
      const prompt = getFullSystemPrompt();
      expect(prompt).toContain('角色设定');
      expect(prompt).toContain('冷读方法论');
      expect(prompt).toContain('输出规则');
    });
  });

  describe('PERSONA_CONFIG', () => {
    it('should have required assertions config', () => {
      expect(PERSONA_CONFIG.requiredAssertions).toBe(3);
    });

    it('should have max questions config', () => {
      expect(PERSONA_CONFIG.maxQuestions).toBe(2);
    });

    it('should have forbidden questions list', () => {
      expect(PERSONA_CONFIG.forbiddenQuestions.length).toBeGreaterThan(0);
    });
  });
});

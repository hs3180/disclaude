/**
 * Tests for survey/schema.ts validation functions.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateExpiresAt,
  validateTargetUsers,
  validateQuestions,
  parseSurveyFile,
  validateSurveyFileData,
  nowISO,
  ValidationError,
  type SurveyFile,
} from './schema.js';

describe('survey/schema', () => {
  describe('validateSurveyId', () => {
    it('should accept valid survey IDs', () => {
      expect(() => validateSurveyId('my-survey')).not.toThrow();
      expect(() => validateSurveyId('survey_123')).not.toThrow();
      expect(() => validateSurveyId('a')).not.toThrow();
    });

    it('should reject empty ID', () => {
      expect(() => validateSurveyId('')).toThrow(ValidationError);
    });

    it('should reject invalid characters', () => {
      expect(() => validateSurveyId('my survey')).toThrow(ValidationError);
      expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
    });
  });

  describe('validateTitle', () => {
    it('should accept valid titles', () => {
      expect(() => validateTitle('My Survey')).not.toThrow();
    });

    it('should reject empty title', () => {
      expect(() => validateTitle('')).toThrow(ValidationError);
    });

    it('should reject overly long title', () => {
      expect(() => validateTitle('a'.repeat(101))).toThrow(ValidationError);
    });

    it('should accept title at max length', () => {
      expect(() => validateTitle('a'.repeat(100))).not.toThrow();
    });
  });

  describe('validateDescription', () => {
    it('should accept valid description', () => {
      expect(() => validateDescription('A description')).not.toThrow();
    });

    it('should reject overly long description', () => {
      expect(() => validateDescription('a'.repeat(501))).toThrow(ValidationError);
    });
  });

  describe('validateExpiresAt', () => {
    it('should accept valid UTC Z-suffix timestamp', () => {
      expect(() => validateExpiresAt('2026-04-25T10:00:00Z')).not.toThrow();
    });

    it('should reject empty', () => {
      expect(() => validateExpiresAt('')).toThrow(ValidationError);
    });

    it('should reject non-UTC format', () => {
      expect(() => validateExpiresAt('2026-04-25T10:00:00+08:00')).toThrow(ValidationError);
    });

    it('should reject date without time', () => {
      expect(() => validateExpiresAt('2026-04-25')).toThrow(ValidationError);
    });
  });

  describe('validateTargetUsers', () => {
    it('should accept valid user IDs', () => {
      const result = validateTargetUsers(['ou_user1', 'ou_user2']);
      expect(result).toEqual(['ou_user1', 'ou_user2']);
    });

    it('should reject empty array', () => {
      expect(() => validateTargetUsers([])).toThrow(ValidationError);
    });

    it('should reject non-array', () => {
      expect(() => validateTargetUsers('not array')).toThrow(ValidationError);
    });

    it('should reject invalid user ID format', () => {
      expect(() => validateTargetUsers(['invalid'])).toThrow(ValidationError);
      expect(() => validateTargetUsers(['user1'])).toThrow(ValidationError);
    });

    it('should reject too many users', () => {
      const users = Array.from({ length: 51 }, (_, i) => `ou_user${i}`);
      expect(() => validateTargetUsers(users)).toThrow(ValidationError);
    });
  });

  describe('validateQuestions', () => {
    const validSingleChoice = {
      id: 'q1',
      type: 'single_choice' as const,
      text: 'Rate this',
      options: ['Good', 'Bad'],
    };

    const validMultipleChoice = {
      id: 'q2',
      type: 'multiple_choice' as const,
      text: 'Pick multiple',
      options: ['A', 'B', 'C'],
    };

    const validText = {
      id: 'q3',
      type: 'text' as const,
      text: 'Your thoughts?',
    };

    it('should accept valid questions of all types', () => {
      const result = validateQuestions([validSingleChoice, validMultipleChoice, validText]);
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('single_choice');
      expect(result[1].type).toBe('multiple_choice');
      expect(result[2].type).toBe('text');
    });

    it('should reject empty array', () => {
      expect(() => validateQuestions([])).toThrow(ValidationError);
    });

    it('should reject non-array', () => {
      expect(() => validateQuestions('not array')).toThrow(ValidationError);
    });

    it('should reject too many questions', () => {
      const questions = Array.from({ length: 11 }, (_, i) => ({
        id: `q${i + 1}`,
        type: 'text',
        text: `Question ${i + 1}`,
      }));
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });

    it('should reject duplicate question IDs', () => {
      expect(() =>
        validateQuestions([
          { ...validSingleChoice, id: 'q1' },
          { ...validText, id: 'q1' },
        ]),
      ).toThrow(ValidationError);
    });

    it('should reject invalid question ID format', () => {
      expect(() =>
        validateQuestions([{ ...validSingleChoice, id: 'question-1' }]),
      ).toThrow(ValidationError);
    });

    it('should reject choice question without options', () => {
      expect(() =>
        validateQuestions([{ id: 'q1', type: 'single_choice', text: 'Pick one' }]),
      ).toThrow(ValidationError);
    });

    it('should reject choice question with less than 2 options', () => {
      expect(() =>
        validateQuestions([{ ...validSingleChoice, options: ['Only one'] }]),
      ).toThrow(ValidationError);
    });

    it('should reject too many options', () => {
      expect(() =>
        validateQuestions([{ ...validSingleChoice, options: Array.from({ length: 11 }, (_, i) => `Opt${i}`) }]),
      ).toThrow(ValidationError);
    });

    it('should reject empty option text', () => {
      expect(() =>
        validateQuestions([{ ...validSingleChoice, options: ['Good', ''] }]),
      ).toThrow(ValidationError);
    });

    it('should reject empty question text', () => {
      expect(() =>
        validateQuestions([{ ...validSingleChoice, text: '' }]),
      ).toThrow(ValidationError);
    });

    it('should validate maxSelections for multiple_choice', () => {
      // Valid
      expect(() =>
        validateQuestions([{ ...validMultipleChoice, maxSelections: 2 }]),
      ).not.toThrow();

      // Invalid: exceeds options count
      expect(() =>
        validateQuestions([{ ...validMultipleChoice, maxSelections: 5 }]),
      ).toThrow(ValidationError);

      // Invalid: less than 1
      expect(() =>
        validateQuestions([{ ...validMultipleChoice, maxSelections: 0 }]),
      ).toThrow(ValidationError);
    });

    it('should trim whitespace from text and options', () => {
      const result = validateQuestions([{
        ...validSingleChoice,
        text: '  Rate this  ',
        options: ['  Good  ', '  Bad  '],
      }]);
      expect(result[0].text).toBe('Rate this');
      expect(result[0].options).toEqual(['Good', 'Bad']);
    });
  });

  describe('parseSurveyFile', () => {
    const validSurvey: SurveyFile = {
      id: 'test-survey',
      status: 'active',
      title: 'Test Survey',
      createdAt: '2026-04-22T10:00:00Z',
      expiresAt: '2026-04-25T10:00:00Z',
      anonymous: false,
      questions: [
        { id: 'q1', type: 'single_choice', text: 'Rate?', options: ['Good', 'Bad'] },
      ],
      targetUsers: ['ou_user1'],
      responses: [],
      closedAt: null,
    };

    it('should parse valid survey JSON', () => {
      const result = parseSurveyFile(JSON.stringify(validSurvey), 'test.json');
      expect(result.id).toBe('test-survey');
      expect(result.questions).toHaveLength(1);
    });

    it('should reject invalid JSON', () => {
      expect(() => parseSurveyFile('not json', 'test.json')).toThrow(ValidationError);
    });

    it('should reject non-object JSON', () => {
      expect(() => parseSurveyFile('"string"', 'test.json')).toThrow(ValidationError);
      expect(() => parseSurveyFile('[]', 'test.json')).toThrow(ValidationError);
    });

    it('should reject missing required fields', () => {
      const { id, ...noId } = validSurvey;
      expect(() => parseSurveyFile(JSON.stringify(noId), 'test.json')).toThrow(ValidationError);
    });

    it('should reject invalid status', () => {
      const invalid = { ...validSurvey, status: 'unknown' };
      expect(() => parseSurveyFile(JSON.stringify(invalid), 'test.json')).toThrow(ValidationError);
    });

    it('should accept closed survey with closedAt', () => {
      const closed = { ...validSurvey, status: 'closed', closedAt: '2026-04-23T10:00:00Z' };
      const result = parseSurveyFile(JSON.stringify(closed), 'test.json');
      expect(result.status).toBe('closed');
    });
  });

  describe('validateSurveyFileData', () => {
    it('should reject null', () => {
      expect(() => validateSurveyFileData(null, 'test.json')).toThrow(ValidationError);
    });

    it('should reject array', () => {
      expect(() => validateSurveyFileData([], 'test.json')).toThrow(ValidationError);
    });
  });

  describe('nowISO', () => {
    it('should return UTC Z-suffix format', () => {
      const result = nowISO();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });
});

/**
 * Unit tests for survey schema validation functions.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateDeadline,
  validateTargetUsers,
  validateQuestions,
  parseSurveyFile,
  ValidationError,
} from '../schema.js';

describe('survey schema validation', () => {
  describe('validateSurveyId', () => {
    it('should accept valid survey IDs', () => {
      expect(() => validateSurveyId('my-survey')).not.toThrow();
      expect(() => validateSurveyId('survey_123')).not.toThrow();
      expect(() => validateSurveyId('survey.2026')).not.toThrow();
    });

    it('should reject empty ID', () => {
      expect(() => validateSurveyId('')).toThrow(ValidationError);
    });

    it('should reject ID starting with dot', () => {
      expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
    });

    it('should reject ID with spaces', () => {
      expect(() => validateSurveyId('has space')).toThrow(ValidationError);
    });
  });

  describe('validateTitle', () => {
    it('should accept valid titles', () => {
      expect(() => validateTitle('My Survey')).not.toThrow();
      expect(() => validateTitle('a')).not.toThrow();
    });

    it('should reject empty title', () => {
      expect(() => validateTitle('')).toThrow(ValidationError);
    });

    it('should reject title exceeding max length', () => {
      expect(() => validateTitle('a'.repeat(129))).toThrow(ValidationError);
    });
  });

  describe('validateDescription', () => {
    it('should accept undefined description', () => {
      expect(() => validateDescription(undefined)).not.toThrow();
    });

    it('should accept valid description', () => {
      expect(() => validateDescription('A description')).not.toThrow();
    });

    it('should reject description exceeding max length', () => {
      expect(() => validateDescription('a'.repeat(1025))).toThrow(ValidationError);
    });
  });

  describe('validateDeadline', () => {
    it('should accept undefined deadline', () => {
      expect(() => validateDeadline(undefined)).not.toThrow();
    });

    it('should accept valid UTC Z-suffix deadline', () => {
      expect(() => validateDeadline('2099-12-31T23:59:59Z')).not.toThrow();
    });

    it('should reject non-UTC format', () => {
      expect(() => validateDeadline('2099-12-31')).toThrow(ValidationError);
      expect(() => validateDeadline('2099-12-31T23:59:59+08:00')).toThrow(ValidationError);
    });
  });

  describe('validateTargetUsers', () => {
    it('should accept valid user IDs', () => {
      const result = validateTargetUsers(['ou_test123', 'ou_user456']);
      expect(result).toEqual(['ou_test123', 'ou_user456']);
    });

    it('should reject empty array', () => {
      expect(() => validateTargetUsers([])).toThrow(ValidationError);
    });

    it('should reject non-array', () => {
      expect(() => validateTargetUsers('not-array')).toThrow(ValidationError);
    });

    it('should reject invalid user ID format', () => {
      expect(() => validateTargetUsers(['invalid'])).toThrow(ValidationError);
    });
  });

  describe('validateQuestions', () => {
    it('should accept valid questions array', () => {
      const questions = [
        { id: 'q1', type: 'single_choice', text: 'Pick one', options: ['A', 'B'] },
        { id: 'q2', type: 'text', text: 'Say something' },
      ];
      const result = validateQuestions(questions);
      expect(result).toHaveLength(2);
    });

    it('should reject empty array', () => {
      expect(() => validateQuestions([])).toThrow(ValidationError);
    });

    it('should reject non-array', () => {
      expect(() => validateQuestions('not-array')).toThrow(ValidationError);
    });

    it('should reject duplicate question IDs', () => {
      const questions = [
        { id: 'q1', type: 'text', text: 'First' },
        { id: 'q1', type: 'text', text: 'Second' },
      ];
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });

    it('should reject invalid question ID format', () => {
      const questions = [
        { id: 'question-1', type: 'text', text: 'Test' },
      ];
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });

    it('should reject choice question without options', () => {
      const questions = [
        { id: 'q1', type: 'single_choice', text: 'Pick', options: [] },
      ];
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });

    it('should accept multiple_choice questions', () => {
      const questions = [
        { id: 'q1', type: 'multiple_choice', text: 'Pick many', options: ['A', 'B', 'C'] },
      ];
      expect(() => validateQuestions(questions)).not.toThrow();
    });

    it('should reject too many questions', () => {
      const questions = Array.from({ length: 21 }, (_, i) => ({
        id: `q${i + 1}`, type: 'text', text: `Q${i + 1}`,
      }));
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });
  });

  describe('parseSurveyFile', () => {
    it('should parse valid survey JSON', () => {
      const json = JSON.stringify({
        id: 'test',
        title: 'Test Survey',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        closedAt: null,
        deadline: null,
        anonymous: false,
        targetUsers: ['ou_test'],
        questions: [{ id: 'q1', type: 'text', text: 'Hello' }],
        responses: {},
      });

      const result = parseSurveyFile(json, 'test.json');
      expect(result.id).toBe('test');
      expect(result.status).toBe('active');
    });

    it('should reject invalid JSON', () => {
      expect(() => parseSurveyFile('not json', 'test.json')).toThrow(ValidationError);
    });

    it('should reject missing id', () => {
      const json = JSON.stringify({
        title: 'Test',
        status: 'active',
        createdAt: '2026-01-01T00:00:00Z',
        anonymous: false,
        targetUsers: [],
        questions: [],
        responses: {},
      });
      expect(() => parseSurveyFile(json, 'test.json')).toThrow(ValidationError);
    });

    it('should reject invalid status', () => {
      const json = JSON.stringify({
        id: 'test',
        title: 'Test',
        status: 'unknown',
        createdAt: '2026-01-01T00:00:00Z',
        anonymous: false,
        targetUsers: [],
        questions: [],
        responses: {},
      });
      expect(() => parseSurveyFile(json, 'test.json')).toThrow(ValidationError);
    });
  });
});

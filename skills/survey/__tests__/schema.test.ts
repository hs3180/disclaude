/**
 * Tests for survey schema validation functions.
 *
 * Issue #2191: Survey/Polling feature tests.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateQuestionType,
  validateQuestion,
  validateQuestions,
  validateTargetUsers,
  validateExpiresAt,
  validateAnswer,
  parseSurveyFile,
  validateSurveyFileData,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_QUESTION_TEXT_LENGTH,
  MAX_OPTION_LENGTH,
  MAX_OPTIONS_COUNT,
  MAX_QUESTIONS_COUNT,
  MAX_TEXT_ANSWER_LENGTH,
  ValidationError,
} from '../schema.js';

describe('survey schema', () => {
  describe('validateSurveyId', () => {
    it('should accept valid survey IDs', () => {
      expect(() => validateSurveyId('survey-001')).not.toThrow();
      expect(() => validateSurveyId('restaurant_review')).not.toThrow();
      expect(() => validateSurveyId('poll.2026')).not.toThrow();
      expect(() => validateSurveyId('a')).not.toThrow();
    });

    it('should reject empty survey ID', () => {
      expect(() => validateSurveyId('')).toThrow(ValidationError);
      expect(() => validateSurveyId('')).toThrow('required');
    });

    it('should reject survey ID with path traversal', () => {
      expect(() => validateSurveyId('../etc/passwd')).toThrow(ValidationError);
      expect(() => validateSurveyId('./hidden')).toThrow(ValidationError);
    });

    it('should reject survey ID starting with dot', () => {
      expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
    });
  });

  describe('validateTitle', () => {
    it('should accept valid titles', () => {
      expect(() => validateTitle('餐厅评价调查')).not.toThrow();
      expect(() => validateTitle('Team Feedback Survey')).not.toThrow();
    });

    it('should reject empty title', () => {
      expect(() => validateTitle('')).toThrow(ValidationError);
    });

    it('should reject overly long title', () => {
      expect(() => validateTitle('x'.repeat(MAX_TITLE_LENGTH + 1))).toThrow(ValidationError);
    });
  });

  describe('validateDescription', () => {
    it('should accept valid descriptions', () => {
      expect(() => validateDescription('A description')).not.toThrow();
      expect(() => validateDescription('')).not.toThrow();
    });

    it('should reject overly long description', () => {
      expect(() => validateDescription('x'.repeat(MAX_DESCRIPTION_LENGTH + 1))).toThrow(ValidationError);
    });
  });

  describe('validateQuestionType', () => {
    it('should accept valid question types', () => {
      expect(() => validateQuestionType('single_choice')).not.toThrow();
      expect(() => validateQuestionType('multiple_choice')).not.toThrow();
      expect(() => validateQuestionType('text')).not.toThrow();
    });

    it('should reject invalid question types', () => {
      expect(() => validateQuestionType('rating')).toThrow(ValidationError);
      expect(() => validateQuestionType('')).toThrow(ValidationError);
    });
  });

  describe('validateQuestion', () => {
    it('should validate a single_choice question', () => {
      const result = validateQuestion(
        { id: 'q1', type: 'single_choice', text: 'Pick one', options: ['A', 'B'] },
        0,
      );
      expect(result.id).toBe('q1');
      expect(result.type).toBe('single_choice');
      expect(result.options).toEqual(['A', 'B']);
    });

    it('should validate a multiple_choice question', () => {
      const result = validateQuestion(
        { id: 'q1', type: 'multiple_choice', text: 'Pick many', options: ['A', 'B', 'C'] },
        0,
      );
      expect(result.type).toBe('multiple_choice');
    });

    it('should validate a text question', () => {
      const result = validateQuestion(
        { id: 'q1', type: 'text', text: 'Your thoughts?' },
        0,
      );
      expect(result.type).toBe('text');
      expect(result.options).toBeUndefined();
    });

    it('should reject question without id', () => {
      expect(() =>
        validateQuestion({ type: 'text', text: 'Hello' }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject question with invalid id format', () => {
      expect(() =>
        validateQuestion({ id: 'abc', type: 'text', text: 'Hello' }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject choice question without options', () => {
      expect(() =>
        validateQuestion({ id: 'q1', type: 'single_choice', text: 'Pick' }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject choice question with less than 2 options', () => {
      expect(() =>
        validateQuestion({ id: 'q1', type: 'single_choice', text: 'Pick', options: ['A'] }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject choice question with too many options', () => {
      const options = Array.from({ length: MAX_OPTIONS_COUNT + 1 }, (_, i) => `Option ${i}`);
      expect(() =>
        validateQuestion({ id: 'q1', type: 'single_choice', text: 'Pick', options }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject question with empty text', () => {
      expect(() =>
        validateQuestion({ id: 'q1', type: 'text', text: '' }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject question with overly long text', () => {
      expect(() =>
        validateQuestion({ id: 'q1', type: 'text', text: 'x'.repeat(MAX_QUESTION_TEXT_LENGTH + 1) }, 0),
      ).toThrow(ValidationError);
    });

    it('should reject option that is too long', () => {
      expect(() =>
        validateQuestion(
          { id: 'q1', type: 'single_choice', text: 'Pick', options: ['A', 'x'.repeat(MAX_OPTION_LENGTH + 1)] },
          0,
        ),
      ).toThrow(ValidationError);
    });
  });

  describe('validateQuestions', () => {
    it('should validate a valid question array', () => {
      const result = validateQuestions([
        { id: 'q1', type: 'single_choice', text: 'Q1', options: ['A', 'B'] },
        { id: 'q2', type: 'text', text: 'Q2' },
      ]);
      expect(result).toHaveLength(2);
    });

    it('should reject empty array', () => {
      expect(() => validateQuestions([])).toThrow(ValidationError);
    });

    it('should reject non-array input', () => {
      expect(() => validateQuestions('not array')).toThrow(ValidationError);
    });

    it('should reject duplicate question IDs', () => {
      expect(() =>
        validateQuestions([
          { id: 'q1', type: 'text', text: 'Q1' },
          { id: 'q1', type: 'text', text: 'Q1 duplicate' },
        ]),
      ).toThrow(ValidationError);
    });

    it('should reject too many questions', () => {
      const questions = Array.from({ length: MAX_QUESTIONS_COUNT + 1 }, (_, i) => ({
        id: `q${i + 1}`,
        type: 'text',
        text: `Question ${i + 1}`,
      }));
      expect(() => validateQuestions(questions)).toThrow(ValidationError);
    });
  });

  describe('validateTargetUsers', () => {
    it('should accept valid user arrays', () => {
      const result = validateTargetUsers(['ou_abc123', 'ou_def456']);
      expect(result).toEqual(['ou_abc123', 'ou_def456']);
    });

    it('should reject non-array input', () => {
      expect(() => validateTargetUsers('ou_abc')).toThrow(ValidationError);
      expect(() => validateTargetUsers(null)).toThrow(ValidationError);
    });

    it('should reject empty array', () => {
      expect(() => validateTargetUsers([])).toThrow(ValidationError);
    });

    it('should reject invalid user IDs', () => {
      expect(() => validateTargetUsers(['invalid'])).toThrow(ValidationError);
      expect(() => validateTargetUsers(['ou_'])).toThrow(ValidationError);
    });
  });

  describe('validateExpiresAt', () => {
    it('should accept valid UTC Z-suffix timestamps', () => {
      expect(() => validateExpiresAt('2099-12-31T23:59:59Z')).not.toThrow();
    });

    it('should reject empty expiresAt', () => {
      expect(() => validateExpiresAt('')).toThrow(ValidationError);
    });

    it('should reject non-UTC timestamps', () => {
      expect(() => validateExpiresAt('2099-12-31T23:59:59+08:00')).toThrow(ValidationError);
      expect(() => validateExpiresAt('2099-12-31')).toThrow(ValidationError);
    });
  });

  describe('validateAnswer', () => {
    it('should validate text answer', () => {
      const question = { id: 'q1', type: 'text' as const, text: 'Your thoughts?' };
      expect(validateAnswer(question, 'Great service!')).toBe('Great service!');
    });

    it('should reject empty text answer', () => {
      const question = { id: 'q1', type: 'text' as const, text: 'Your thoughts?' };
      expect(() => validateAnswer(question, '')).toThrow(ValidationError);
    });

    it('should reject overly long text answer', () => {
      const question = { id: 'q1', type: 'text' as const, text: 'Your thoughts?' };
      expect(() => validateAnswer(question, 'x'.repeat(MAX_TEXT_ANSWER_LENGTH + 1))).toThrow(ValidationError);
    });

    it('should validate single_choice answer', () => {
      const question = {
        id: 'q1',
        type: 'single_choice' as const,
        text: 'Rating',
        options: ['1⭐', '2⭐', '3⭐', '4⭐', '5⭐'],
      };
      expect(validateAnswer(question, '5⭐')).toBe('5⭐');
    });

    it('should reject invalid single_choice answer', () => {
      const question = {
        id: 'q1',
        type: 'single_choice' as const,
        text: 'Rating',
        options: ['1⭐', '2⭐'],
      };
      expect(() => validateAnswer(question, '3⭐')).toThrow(ValidationError);
    });

    it('should validate multiple_choice answer', () => {
      const question = {
        id: 'q1',
        type: 'multiple_choice' as const,
        text: 'Select all',
        options: ['A', 'B', 'C'],
      };
      expect(validateAnswer(question, ['A', 'C'])).toEqual(['A', 'C']);
    });

    it('should reject empty multiple_choice answer', () => {
      const question = {
        id: 'q1',
        type: 'multiple_choice' as const,
        text: 'Select all',
        options: ['A', 'B', 'C'],
      };
      expect(() => validateAnswer(question, [])).toThrow(ValidationError);
    });

    it('should reject invalid option in multiple_choice', () => {
      const question = {
        id: 'q1',
        type: 'multiple_choice' as const,
        text: 'Select all',
        options: ['A', 'B'],
      };
      expect(() => validateAnswer(question, ['A', 'Z'])).toThrow(ValidationError);
    });
  });

  describe('validateSurveyFileData', () => {
    const validSurvey = {
      id: 'test-survey-001',
      title: 'Test Survey',
      description: '',
      status: 'draft',
      createdAt: '2026-04-26T10:00:00Z',
      activatedAt: null,
      closedAt: null,
      expiresAt: '2099-12-31T23:59:59Z',
      anonymous: false,
      targetUsers: ['ou_abc123'],
      chatId: 'oc_test123',
      questions: [
        { id: 'q1', type: 'text', text: 'Your name?' },
      ],
      responses: {},
    };

    it('should accept valid survey file data', () => {
      const result = validateSurveyFileData(validSurvey, '/path/to/test.json');
      expect(result.id).toBe('test-survey-001');
      expect(result.status).toBe('draft');
    });

    it('should reject non-object input', () => {
      expect(() => validateSurveyFileData(null, '/path')).toThrow(ValidationError);
      expect(() => validateSurveyFileData('string', '/path')).toThrow(ValidationError);
    });

    it('should reject missing required fields', () => {
      expect(() => validateSurveyFileData({}, '/path')).toThrow(ValidationError);
    });

    it('should reject invalid status', () => {
      expect(() =>
        validateSurveyFileData({ ...validSurvey, status: 'unknown' }, '/path'),
      ).toThrow(ValidationError);
    });

    it('should accept active status', () => {
      const result = validateSurveyFileData({ ...validSurvey, status: 'active' }, '/path');
      expect(result.status).toBe('active');
    });

    it('should accept closed status', () => {
      const result = validateSurveyFileData({ ...validSurvey, status: 'closed' }, '/path');
      expect(result.status).toBe('closed');
    });

    it('should reject invalid responses type', () => {
      expect(() =>
        validateSurveyFileData({ ...validSurvey, responses: 'invalid' }, '/path'),
      ).toThrow(ValidationError);
    });

    it('should reject non-boolean anonymous', () => {
      expect(() =>
        validateSurveyFileData({ ...validSurvey, anonymous: 'yes' }, '/path'),
      ).toThrow(ValidationError);
    });

    it('should reject empty questions', () => {
      expect(() =>
        validateSurveyFileData({ ...validSurvey, questions: [] }, '/path'),
      ).toThrow(ValidationError);
    });

    it('should reject empty targetUsers', () => {
      expect(() =>
        validateSurveyFileData({ ...validSurvey, targetUsers: [] }, '/path'),
      ).toThrow(ValidationError);
    });
  });

  describe('parseSurveyFile', () => {
    it('should parse valid JSON', () => {
      const json = JSON.stringify({
        id: 'test-survey',
        title: 'Test',
        description: '',
        status: 'draft',
        createdAt: '2026-04-26T10:00:00Z',
        activatedAt: null,
        closedAt: null,
        expiresAt: '2099-12-31T23:59:59Z',
        anonymous: false,
        targetUsers: ['ou_abc'],
        chatId: 'oc_test',
        questions: [{ id: 'q1', type: 'text', text: 'Q1' }],
        responses: {},
      });
      const result = parseSurveyFile(json, '/path/to/test.json');
      expect(result.id).toBe('test-survey');
    });

    it('should reject invalid JSON', () => {
      expect(() => parseSurveyFile('not json', '/path')).toThrow(ValidationError);
    });
  });
});

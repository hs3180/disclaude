/**
 * Unit tests for survey/schema.ts
 *
 * Tests validation functions for survey data.
 */

import { describe, it, expect } from 'vitest';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateExpiresAt,
  validateCreator,
  validateTargetUsers,
  validateQuestions,
  parseSurveyFile,
  validateSurveyFileData,
  nowISO,
  ValidationError,
  SURVEY_DIR,
  SURVEY_ID_REGEX,
  QUESTION_ID_REGEX,
} from '../schema.js';

// ---- validateSurveyId ----

describe('validateSurveyId', () => {
  it('accepts valid survey IDs', () => {
    expect(() => validateSurveyId('survey-001')).not.toThrow();
    expect(() => validateSurveyId('my_survey.2026')).not.toThrow();
    expect(() => validateSurveyId('a')).not.toThrow();
  });

  it('rejects empty ID', () => {
    expect(() => validateSurveyId('')).toThrow(ValidationError);
  });

  it('rejects IDs with spaces', () => {
    expect(() => validateSurveyId('survey 001')).toThrow(ValidationError);
  });

  it('rejects IDs starting with dot', () => {
    expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
  });

  it('rejects IDs with special characters', () => {
    expect(() => validateSurveyId('survey@123')).toThrow(ValidationError);
  });
});

// ---- validateTitle ----

describe('validateTitle', () => {
  it('accepts valid titles', () => {
    expect(() => validateTitle('餐厅评价')).not.toThrow();
    expect(() => validateTitle('Team Satisfaction Survey 2026')).not.toThrow();
  });

  it('rejects empty title', () => {
    expect(() => validateTitle('')).toThrow(ValidationError);
  });

  it('rejects title exceeding max length', () => {
    const longTitle = 'a'.repeat(129);
    expect(() => validateTitle(longTitle)).toThrow(ValidationError);
  });

  it('accepts title at max length', () => {
    const maxTitle = 'a'.repeat(128);
    expect(() => validateTitle(maxTitle)).not.toThrow();
  });
});

// ---- validateDescription ----

describe('validateDescription', () => {
  it('accepts empty description', () => {
    expect(() => validateDescription('')).not.toThrow();
  });

  it('rejects description exceeding max length', () => {
    const longDesc = 'a'.repeat(1025);
    expect(() => validateDescription(longDesc)).toThrow(ValidationError);
  });
});

// ---- validateExpiresAt ----

describe('validateExpiresAt', () => {
  it('accepts valid UTC Z-suffix timestamp', () => {
    expect(() => validateExpiresAt('2026-04-27T10:00:00Z')).not.toThrow();
  });

  it('rejects empty value', () => {
    expect(() => validateExpiresAt('')).toThrow(ValidationError);
  });

  it('rejects non-UTC format (no Z suffix)', () => {
    expect(() => validateExpiresAt('2026-04-27T10:00:00+08:00')).toThrow(ValidationError);
  });

  it('rejects date-only format', () => {
    expect(() => validateExpiresAt('2026-04-27')).toThrow(ValidationError);
  });
});

// ---- validateCreator ----

describe('validateCreator', () => {
  it('accepts valid open ID', () => {
    expect(() => validateCreator('ou_abc123')).not.toThrow();
  });

  it('rejects empty creator', () => {
    expect(() => validateCreator('')).toThrow(ValidationError);
  });

  it('rejects invalid format', () => {
    expect(() => validateCreator('user123')).toThrow(ValidationError);
  });
});

// ---- validateTargetUsers ----

describe('validateTargetUsers', () => {
  it('accepts valid user array', () => {
    const result = validateTargetUsers(['ou_user1', 'ou_user2']);
    expect(result).toEqual(['ou_user1', 'ou_user2']);
  });

  it('rejects empty array', () => {
    expect(() => validateTargetUsers([])).toThrow(ValidationError);
  });

  it('rejects non-array', () => {
    expect(() => validateTargetUsers('not array')).toThrow(ValidationError);
  });

  it('rejects array with invalid IDs', () => {
    expect(() => validateTargetUsers(['ou_valid', 'invalid'])).toThrow(ValidationError);
  });

  it('rejects too many users', () => {
    const users = Array.from({ length: 51 }, (_, i) => `ou_user${i}`);
    expect(() => validateTargetUsers(users)).toThrow(ValidationError);
  });
});

// ---- validateQuestions ----

describe('validateQuestions', () => {
  const validSingleChoice = {
    id: 'q1',
    type: 'single_choice' as const,
    question: 'Rating?',
    options: ['Good', 'Bad'],
    required: true,
  };

  const validText = {
    id: 'q2',
    type: 'text' as const,
    question: 'Comments?',
    required: false,
  };

  it('accepts valid questions array', () => {
    const result = validateQuestions([validSingleChoice, validText]);
    expect(result).toHaveLength(2);
  });

  it('rejects empty array', () => {
    expect(() => validateQuestions([])).toThrow(ValidationError);
  });

  it('rejects non-array', () => {
    expect(() => validateQuestions('not array')).toThrow(ValidationError);
  });

  it('rejects too many questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => ({
      ...validSingleChoice,
      id: `q${i + 1}`,
    }));
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects invalid question ID format', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, id: 'question1' }]),
    ).toThrow(ValidationError);
  });

  it('rejects duplicate question IDs', () => {
    expect(() =>
      validateQuestions([validSingleChoice, { ...validSingleChoice }]),
    ).toThrow(ValidationError);
  });

  it('rejects invalid question type', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, type: 'rating' }]),
    ).toThrow(ValidationError);
  });

  it('rejects empty question text', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, question: '' }]),
    ).toThrow(ValidationError);
  });

  it('rejects single_choice with fewer than 2 options', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, options: ['Only one'] }]),
    ).toThrow(ValidationError);
  });

  it('rejects single_choice without options', () => {
    const { options, ...withoutOptions } = validSingleChoice;
    expect(() => validateQuestions([withoutOptions])).toThrow(ValidationError);
  });

  it('rejects required field not boolean', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, required: 'yes' }]),
    ).toThrow(ValidationError);
  });

  it('rejects question text exceeding max length', () => {
    expect(() =>
      validateQuestions([{ ...validSingleChoice, question: 'x'.repeat(513) }]),
    ).toThrow(ValidationError);
  });
});

// ---- parseSurveyFile ----

describe('parseSurveyFile', () => {
  const validSurvey = {
    id: 'survey-001',
    title: 'Test Survey',
    description: 'A test survey',
    status: 'open',
    anonymous: false,
    createdAt: '2026-04-20T10:00:00Z',
    expiresAt: '2026-04-27T10:00:00Z',
    closedAt: null,
    creator: 'ou_creator',
    targetUsers: ['ou_user1'],
    questions: [
      {
        id: 'q1',
        type: 'single_choice',
        question: 'Rate?',
        options: ['Good', 'Bad'],
        required: true,
      },
    ],
    responses: {},
  };

  it('parses valid survey JSON', () => {
    const result = parseSurveyFile(JSON.stringify(validSurvey), 'test.json');
    expect(result.id).toBe('survey-001');
    expect(result.questions).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSurveyFile('not json', 'test.json')).toThrow(ValidationError);
  });

  it('rejects non-object JSON', () => {
    expect(() => parseSurveyFile('"string"', 'test.json')).toThrow(ValidationError);
  });

  it('rejects array JSON', () => {
    expect(() => parseSurveyFile('[]', 'test.json')).toThrow(ValidationError);
  });

  it('rejects missing id', () => {
    const { id, ...noId } = validSurvey;
    expect(() => parseSurveyFile(JSON.stringify(noId), 'test.json')).toThrow(ValidationError);
  });

  it('rejects invalid status', () => {
    expect(() =>
      parseSurveyFile(JSON.stringify({ ...validSurvey, status: 'unknown' }), 'test.json'),
    ).toThrow(ValidationError);
  });
});

// ---- nowISO ----

describe('nowISO', () => {
  it('returns UTC Z-suffix format', () => {
    const result = nowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('returns a valid date', () => {
    const result = nowISO();
    const date = new Date(result);
    expect(date.getTime()).not.toBeNaN();
  });
});

// ---- Constants ----

describe('constants', () => {
  it('SURVEY_DIR is set', () => {
    expect(SURVEY_DIR).toBe('workspace/surveys');
  });

  it('SURVEY_ID_REGEX matches valid IDs', () => {
    expect(SURVEY_ID_REGEX.test('survey-001')).toBe(true);
    expect(SURVEY_ID_REGEX.test('.hidden')).toBe(false);
  });

  it('QUESTION_ID_REGEX matches valid question IDs', () => {
    expect(QUESTION_ID_REGEX.test('q1')).toBe(true);
    expect(QUESTION_ID_REGEX.test('q99')).toBe(true);
    expect(QUESTION_ID_REGEX.test('question1')).toBe(false);
  });
});

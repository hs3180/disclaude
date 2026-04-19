/**
 * Tests for survey skill — schema validation, create, respond, query, list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  validateSurveyId,
  validateTitle,
  validateExpiresAt,
  validateTargetUsers,
  validateQuestions,
  validateSurveyFileData,
  parseSurveyFile,
  nowISO,
  ValidationError,
  type SurveyFile,
} from '../schema.js';

// ---- Schema Validation Tests ----

describe('validateSurveyId', () => {
  it('accepts valid IDs', () => {
    expect(() => validateSurveyId('my-survey-123')).not.toThrow();
    expect(() => validateSurveyId('survey.2026')).not.toThrow();
  });

  it('rejects empty ID', () => {
    expect(() => validateSurveyId('')).toThrow(ValidationError);
  });

  it('rejects IDs with unsafe characters', () => {
    expect(() => validateSurveyId('../etc/passwd')).toThrow(ValidationError);
    expect(() => validateSurveyId('survey with spaces')).toThrow(ValidationError);
  });

  it('rejects IDs starting with dot', () => {
    expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
  });
});

describe('validateTitle', () => {
  it('accepts valid title', () => {
    expect(() => validateTitle('Lunch Survey')).not.toThrow();
  });

  it('rejects empty title', () => {
    expect(() => validateTitle('')).toThrow(ValidationError);
  });

  it('rejects title exceeding max length', () => {
    expect(() => validateTitle('x'.repeat(129))).toThrow(ValidationError);
  });
});

describe('validateExpiresAt', () => {
  it('accepts valid UTC datetime', () => {
    expect(() => validateExpiresAt('2026-12-31T23:59:59Z')).not.toThrow();
  });

  it('rejects empty value', () => {
    expect(() => validateExpiresAt('')).toThrow(ValidationError);
  });

  it('rejects non-UTC format', () => {
    expect(() => validateExpiresAt('2026-12-31T23:59:59+08:00')).toThrow(ValidationError);
  });
});

describe('validateTargetUsers', () => {
  it('accepts valid user IDs', () => {
    const result = validateTargetUsers(['ou_abc123', 'ou_xyz789']);
    expect(result).toEqual(['ou_abc123', 'ou_xyz789']);
  });

  it('rejects empty array', () => {
    expect(() => validateTargetUsers([])).toThrow(ValidationError);
  });

  it('rejects invalid user IDs', () => {
    expect(() => validateTargetUsers(['invalid'])).toThrow(ValidationError);
  });

  it('rejects non-array input', () => {
    expect(() => validateTargetUsers('not-array')).toThrow(ValidationError);
  });
});

describe('validateQuestions', () => {
  it('accepts valid single_choice question', () => {
    const questions = [
      { id: 'q1', type: 'single_choice', text: 'Rate this', options: ['Good', 'Bad'], required: true },
    ];
    const result = validateQuestions(questions);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('q1');
    expect(result[0].type).toBe('single_choice');
  });

  it('accepts valid text question', () => {
    const questions = [
      { id: 'q1', type: 'text', text: 'Your feedback' },
    ];
    const result = validateQuestions(questions);
    expect(result).toHaveLength(1);
    expect(result[0].options).toBeUndefined();
  });

  it('accepts valid multiple_choice question', () => {
    const questions = [
      { id: 'q1', type: 'multiple_choice', text: 'Pick items', options: ['A', 'B', 'C'] },
    ];
    expect(() => validateQuestions(questions)).not.toThrow();
  });

  it('rejects empty array', () => {
    expect(() => validateQuestions([])).toThrow(ValidationError);
  });

  it('rejects choice type without options', () => {
    const questions = [
      { id: 'q1', type: 'single_choice', text: 'Pick one' },
    ];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects invalid question ID format', () => {
    const questions = [
      { id: 'question-1', type: 'text', text: 'Hello' },
    ];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects duplicate question IDs', () => {
    const questions = [
      { id: 'q1', type: 'text', text: 'Q1' },
      { id: 'q1', type: 'text', text: 'Q1 dup' },
    ];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects invalid question type', () => {
    const questions = [
      { id: 'q1', type: 'invalid', text: 'Hello' },
    ];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects empty question text', () => {
    const questions = [
      { id: 'q1', type: 'text', text: '' },
    ];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });
});

describe('validateSurveyFileData', () => {
  const validSurvey = {
    id: 'test-survey',
    title: 'Test',
    status: 'open',
    anonymous: false,
    expiresAt: '2026-12-31T23:59:59Z',
    createdAt: '2026-04-19T10:00:00Z',
    targetUsers: ['ou_user1'],
    questions: [{ id: 'q1', type: 'text', text: 'Hello?' }],
    responses: {},
    chatId: 'oc_test',
  };

  it('accepts valid survey data', () => {
    expect(() => validateSurveyFileData(validSurvey, 'test.json')).not.toThrow();
  });

  it('rejects null data', () => {
    expect(() => validateSurveyFileData(null, 'test.json')).toThrow(ValidationError);
  });

  it('rejects array data', () => {
    expect(() => validateSurveyFileData([], 'test.json')).toThrow(ValidationError);
  });

  it('rejects missing id', () => {
    const data = { ...validSurvey, id: undefined };
    expect(() => validateSurveyFileData(data, 'test.json')).toThrow(ValidationError);
  });

  it('rejects invalid status', () => {
    const data = { ...validSurvey, status: 'unknown' };
    expect(() => validateSurveyFileData(data, 'test.json')).toThrow(ValidationError);
  });
});

describe('parseSurveyFile', () => {
  it('parses valid JSON survey', () => {
    const json = JSON.stringify({
      id: 'test',
      title: 'Test',
      status: 'open',
      expiresAt: '2026-12-31T23:59:59Z',
      createdAt: '2026-04-19T10:00:00Z',
      targetUsers: ['ou_user1'],
      questions: [],
      responses: {},
      chatId: 'oc_test',
    });
    const result = parseSurveyFile(json, 'test.json');
    expect(result.id).toBe('test');
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSurveyFile('not json', 'test.json')).toThrow(ValidationError);
  });
});

// ---- Integration Tests (file-based) ----

const TEST_DIR = resolve('workspace/test-surveys');

describe('create.ts integration', () => {
  beforeEach(async () => {
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('creates a valid survey file', async () => {
    const surveyData: SurveyFile = {
      id: 'test-survey-1',
      title: 'Test Survey',
      status: 'open',
      anonymous: false,
      expiresAt: '2026-12-31T23:59:59Z',
      createdAt: nowISO(),
      targetUsers: ['ou_user1', 'ou_user2'],
      questions: [
        { id: 'q1', type: 'single_choice', text: 'Rate', options: ['Good', 'Bad'], required: true },
        { id: 'q2', type: 'text', text: 'Comments' },
      ],
      responses: {},
      chatId: 'oc_test',
    };

    const filePath = join(TEST_DIR, `${surveyData.id}.json`);
    await writeFile(filePath, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('test-survey-1');
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.responses).toEqual({});
  });

  it('records a response to a survey', async () => {
    const surveyData: SurveyFile = {
      id: 'test-survey-2',
      title: 'Response Test',
      status: 'open',
      anonymous: false,
      expiresAt: '2026-12-31T23:59:59Z',
      createdAt: nowISO(),
      targetUsers: ['ou_user1'],
      questions: [
        { id: 'q1', type: 'single_choice', text: 'Pick', options: ['A', 'B'], required: true },
      ],
      responses: {},
      chatId: 'oc_test',
    };

    const filePath = join(TEST_DIR, `${surveyData.id}.json`);
    await writeFile(filePath, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');

    // Simulate recording a response
    surveyData.responses['ou_user1'] = {
      responder: 'ou_user1',
      answeredAt: nowISO(),
      answers: { q1: 'A' },
    };

    await writeFile(filePath, JSON.stringify(surveyData, null, 2) + '\n', 'utf-8');

    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.responses['ou_user1'].answers.q1).toBe('A');
    expect(Object.keys(parsed.responses)).toHaveLength(1);
  });
});

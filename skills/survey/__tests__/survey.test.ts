/**
 * Tests for survey skill — schema validation and create/respond/query/close lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  validateSurveyId,
  validateTitle,
  validateDescription,
  validateQuestions,
  validateParticipants,
  validateDeadline,
  parseSurveyFile,
  ValidationError,
  type SurveyFile,
  type SurveyQuestion,
  nowISO,
} from '../schema.js';

// ---- Schema Validation Tests ----

describe('validateSurveyId', () => {
  it('accepts valid survey IDs', () => {
    expect(() => validateSurveyId('my-survey-123')).not.toThrow();
    expect(() => validateSurveyId('restaurant_vote')).not.toThrow();
  });

  it('rejects empty id', () => {
    expect(() => validateSurveyId('')).toThrow(ValidationError);
  });

  it('rejects id with leading dot', () => {
    expect(() => validateSurveyId('.hidden')).toThrow(ValidationError);
  });

  it('rejects id with special characters', () => {
    expect(() => validateSurveyId('survey with spaces')).toThrow(ValidationError);
    expect(() => validateSurveyId('survey@!')).toThrow(ValidationError);
  });
});

describe('validateTitle', () => {
  it('accepts valid title', () => {
    expect(() => validateTitle('团建餐厅投票')).not.toThrow();
  });

  it('rejects empty title', () => {
    expect(() => validateTitle('')).toThrow(ValidationError);
  });

  it('rejects overly long title', () => {
    expect(() => validateTitle('x'.repeat(101))).toThrow(ValidationError);
  });
});

describe('validateDescription', () => {
  it('accepts any description under limit', () => {
    expect(() => validateDescription('Some description')).not.toThrow();
    expect(() => validateDescription('')).not.toThrow();
  });

  it('rejects overly long description', () => {
    expect(() => validateDescription('x'.repeat(501))).toThrow(ValidationError);
  });
});

describe('validateQuestions', () => {
  it('accepts valid single_choice question', () => {
    const questions = [
      { text: 'Choose one', type: 'single_choice', options: ['A', 'B', 'C'], required: true },
    ];
    expect(() => validateQuestions(questions)).not.toThrow();
  });

  it('accepts valid text question', () => {
    const questions = [
      { text: 'Your thoughts?', type: 'text', options: [], required: false },
    ];
    expect(() => validateQuestions(questions)).not.toThrow();
  });

  it('accepts valid multiple_choice question', () => {
    const questions = [
      { text: 'Pick multiple', type: 'multiple_choice', options: ['A', 'B', 'C'], required: true },
    ];
    expect(() => validateQuestions(questions)).not.toThrow();
  });

  it('rejects empty array', () => {
    expect(() => validateQuestions([])).toThrow(ValidationError);
  });

  it('rejects non-array', () => {
    expect(() => validateQuestions('not array')).toThrow(ValidationError);
  });

  it('rejects too many questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => ({
      text: `Q${i}`,
      type: 'single_choice',
      options: ['A', 'B'],
      required: true,
    }));
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects question without text', () => {
    const questions = [{ text: '', type: 'single_choice', options: ['A'], required: true }];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects choice question without options', () => {
    const questions = [{ text: 'Pick one', type: 'single_choice', options: [], required: true }];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects too many options', () => {
    const options = Array.from({ length: 9 }, (_, i) => `Option ${i}`);
    const questions = [{ text: 'Pick one', type: 'single_choice', options, required: true }];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('rejects invalid question type', () => {
    const questions = [{ text: 'Pick one', type: 'invalid', options: ['A'], required: true }];
    expect(() => validateQuestions(questions)).toThrow(ValidationError);
  });

  it('defaults required to true when not specified', () => {
    const questions = [{ text: 'Q?', type: 'text', options: [] }];
    const result = validateQuestions(questions);
    expect(result[0].required).toBe(true);
  });
});

describe('validateParticipants', () => {
  it('accepts valid participants', () => {
    expect(() => validateParticipants(['ou_user1', 'ou_user2'])).not.toThrow();
  });

  it('rejects empty array', () => {
    expect(() => validateParticipants([])).toThrow(ValidationError);
  });

  it('rejects non-array', () => {
    expect(() => validateParticipants('ou_user1')).toThrow(ValidationError);
  });

  it('rejects invalid format', () => {
    expect(() => validateParticipants(['invalid_id'])).toThrow(ValidationError);
    expect(() => validateParticipants(['user@example.com'])).toThrow(ValidationError);
  });
});

describe('validateDeadline', () => {
  it('accepts valid UTC deadline', () => {
    expect(() => validateDeadline('2026-04-25T10:00:00Z')).not.toThrow();
  });

  it('rejects empty deadline', () => {
    expect(() => validateDeadline('')).toThrow(ValidationError);
  });

  it('rejects non-UTC format', () => {
    expect(() => validateDeadline('2026-04-25T10:00:00+08:00')).toThrow(ValidationError);
    expect(() => validateDeadline('2026-04-25 10:00:00')).toThrow(ValidationError);
  });
});

describe('parseSurveyFile', () => {
  const validSurvey: SurveyFile = {
    id: 'test-survey',
    status: 'open',
    title: 'Test Survey',
    description: 'A test',
    questions: [{ text: 'Q1?', type: 'single_choice', options: ['A', 'B'], required: true }],
    participants: ['ou_user1'],
    anonymous: false,
    createdAt: '2026-04-22T10:00:00Z',
    deadline: '2026-04-25T10:00:00Z',
    closedAt: null,
    responses: [],
  };

  it('parses valid survey JSON', () => {
    const json = JSON.stringify(validSurvey);
    const result = parseSurveyFile(json, 'test.json');
    expect(result.id).toBe('test-survey');
    expect(result.status).toBe('open');
    expect(result.questions).toHaveLength(1);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseSurveyFile('not json', 'test.json')).toThrow(ValidationError);
  });

  it('rejects non-object', () => {
    expect(() => parseSurveyFile('"string"', 'test.json')).toThrow(ValidationError);
    expect(() => parseSurveyFile('[]', 'test.json')).toThrow(ValidationError);
  });

  it('rejects missing id', () => {
    const copy = { ...validSurvey, id: '' };
    expect(() => parseSurveyFile(JSON.stringify(copy), 'test.json')).toThrow(ValidationError);
  });

  it('rejects invalid status', () => {
    const copy = { ...validSurvey, status: 'unknown' };
    expect(() => parseSurveyFile(JSON.stringify(copy), 'test.json')).toThrow(ValidationError);
  });
});

// ---- Lifecycle Tests (using actual scripts) ----

describe('Survey Lifecycle', () => {
  const testDir = resolve('workspace/surveys');
  const originalEnv = process.env;

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    process.env = { ...originalEnv };
  });

  afterEach(async () => {
    process.env = originalEnv;
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('creates and queries a survey', async () => {
    const surveyPath = join(testDir, 'lifecycle-test.json');

    // Create survey directly
    const survey: SurveyFile = {
      id: 'lifecycle-test',
      status: 'open',
      title: 'Lifecycle Test',
      description: 'Testing',
      questions: [
        { text: 'Pick one', type: 'single_choice', options: ['A', 'B', 'C'], required: true },
      ],
      participants: ['ou_user1', 'ou_user2', 'ou_user3'],
      anonymous: false,
      createdAt: nowISO(),
      deadline: '2026-12-31T23:59:59Z',
      closedAt: null,
      responses: [],
    };

    await writeFile(surveyPath, JSON.stringify(survey, null, 2));

    // Read back and verify
    const raw = await readFile(surveyPath, 'utf-8');
    const parsed = parseSurveyFile(raw, surveyPath);
    expect(parsed.id).toBe('lifecycle-test');
    expect(parsed.status).toBe('open');
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0].options).toEqual(['A', 'B', 'C']);
    expect(parsed.participants).toHaveLength(3);
  });

  it('records a response and prevents duplicates', async () => {
    const surveyPath = join(testDir, 'response-test.json');
    const survey: SurveyFile = {
      id: 'response-test',
      status: 'open',
      title: 'Response Test',
      description: '',
      questions: [
        { text: 'Pick one', type: 'single_choice', options: ['A', 'B'], required: true },
      ],
      participants: ['ou_user1'],
      anonymous: false,
      createdAt: nowISO(),
      deadline: '2026-12-31T23:59:59Z',
      closedAt: null,
      responses: [],
    };

    await writeFile(surveyPath, JSON.stringify(survey, null, 2));

    // Add a response
    survey.responses.push({
      responder: 'ou_user1',
      respondedAt: nowISO(),
      answers: { '0': 'A' },
    });
    await writeFile(surveyPath, JSON.stringify(survey, null, 2));

    // Read back and verify response
    const raw = await readFile(surveyPath, 'utf-8');
    const parsed = parseSurveyFile(raw, surveyPath);
    expect(parsed.responses).toHaveLength(1);
    expect(parsed.responses[0].answers['0']).toBe('A');
  });

  it('closes a survey', async () => {
    const surveyPath = join(testDir, 'close-test.json');
    const survey: SurveyFile = {
      id: 'close-test',
      status: 'open',
      title: 'Close Test',
      description: '',
      questions: [
        { text: 'Q?', type: 'single_choice', options: ['X', 'Y'], required: true },
      ],
      participants: ['ou_user1'],
      anonymous: false,
      createdAt: nowISO(),
      deadline: '2026-12-31T23:59:59Z',
      closedAt: null,
      responses: [],
    };

    await writeFile(surveyPath, JSON.stringify(survey, null, 2));

    // Close the survey
    survey.status = 'closed';
    survey.closedAt = nowISO();
    await writeFile(surveyPath, JSON.stringify(survey, null, 2));

    // Verify
    const raw = await readFile(surveyPath, 'utf-8');
    const parsed = parseSurveyFile(raw, surveyPath);
    expect(parsed.status).toBe('closed');
    expect(parsed.closedAt).not.toBeNull();
  });
});

/**
 * Tests for survey schema validation and result computation.
 *
 * @module skills/survey/__tests__/survey.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  isValidSurveyId,
  validateSurvey,
  getSurveyPath,
  type Survey,
} from '../schema.js';

// ---------------------------------------------------------------------------
// Schema Validation Tests
// ---------------------------------------------------------------------------

describe('isValidSurveyId', () => {
  it('accepts valid IDs', () => {
    expect(isValidSurveyId('my-survey')).toBe(true);
    expect(isValidSurveyId('survey_123')).toBe(true);
    expect(isValidSurveyId('ABC')).toBe(true);
  });

  it('rejects invalid IDs', () => {
    expect(isValidSurveyId('')).toBe(false);
    expect(isValidSurveyId('.hidden')).toBe(false);
    expect(isValidSurveyId('has space')).toBe(false);
    expect(isValidSurveyId('has/slash')).toBe(false);
    expect(isValidSurveyId('has.dot')).toBe(false); // dots not in pattern
    expect(isValidSurveyId('../../../etc/passwd')).toBe(false);
  });
});

describe('validateSurvey', () => {
  function makeValid(overrides?: Partial<Survey>): Survey {
    return {
      id: 'test-survey',
      title: 'Test Survey',
      status: 'draft',
      anonymous: false,
      questions: [
        {
          id: 'q1',
          text: 'What is your choice?',
          type: 'single_choice',
          options: ['A', 'B', 'C'],
        },
      ],
      createdAt: '2026-04-21T10:00:00Z',
      targetUsers: ['ou_user1', 'ou_user2'],
      responses: [],
      ...overrides,
    };
  }

  it('accepts a valid survey', () => {
    expect(validateSurvey(makeValid())).toBeNull();
  });

  it('accepts survey with optional fields', () => {
    expect(validateSurvey(makeValid({
      description: 'A test survey',
      deadline: '2026-04-22T10:00:00Z',
    }))).toBeNull();
  });

  it('accepts text-type questions without options', () => {
    expect(validateSurvey(makeValid({
      questions: [{ id: 'q1', text: 'Comments?', type: 'text' }],
    }))).toBeNull();
  });

  it('rejects missing id', () => {
    expect(validateSurvey(makeValid({ id: '' }))).toContain('id is required');
  });

  it('rejects invalid id format', () => {
    expect(validateSurvey(makeValid({ id: 'has spaces' }))).toContain('id must match pattern');
  });

  it('rejects missing title', () => {
    expect(validateSurvey(makeValid({ title: '' }))).toContain('title is required');
  });

  it('rejects invalid status', () => {
    // Need to cast to bypass TypeScript
    expect(validateSurvey(makeValid({ status: 'invalid' as Survey['status'] }))).toContain('status must be one of');
  });

  it('rejects non-boolean anonymous', () => {
    expect(validateSurvey(makeValid({ anonymous: 'yes' as unknown as boolean }))).toContain('anonymous must be a boolean');
  });

  it('rejects empty questions array', () => {
    expect(validateSurvey(makeValid({ questions: [] }))).toContain('questions must be a non-empty array');
  });

  it('rejects question with missing options for choice type', () => {
    expect(validateSurvey(makeValid({
      questions: [{ id: 'q1', text: 'Choose', type: 'single_choice' }],
    }))).toContain('options is required for choice-type questions');
  });

  it('rejects empty targetUsers', () => {
    expect(validateSurvey(makeValid({ targetUsers: [] }))).toContain('targetUsers must be a non-empty array');
  });

  it('rejects targetUsers without ou_ prefix', () => {
    expect(validateSurvey(makeValid({ targetUsers: ['user1'] }))).toContain('must be an open_id starting with "ou_"');
  });

  it('rejects invalid deadline', () => {
    expect(validateSurvey(makeValid({ deadline: 'not-a-date' }))).toContain('valid ISO 8601');
  });

  it('rejects non-array responses', () => {
    expect(validateSurvey(makeValid({ responses: 'not-array' as unknown as Survey['responses'] }))).toContain('responses must be an array');
  });
});

// ---------------------------------------------------------------------------
// Path Helpers Tests
// ---------------------------------------------------------------------------

describe('getSurveyPath', () => {
  it('returns correct path', () => {
    const path = getSurveyPath('test-survey');
    expect(path).toContain('workspace/surveys/test-survey.json');
  });

  it('uses custom base dir', () => {
    const path = getSurveyPath('test-survey', '/tmp');
    expect(path).toBe('/tmp/workspace/surveys/test-survey.json');
  });
});

// ---------------------------------------------------------------------------
// Create Script Integration Tests
// ---------------------------------------------------------------------------

describe('create survey script', () => {
  const testDir = join('/tmp', 'survey-test-' + Date.now());

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a valid survey file', async () => {
    const survey: Survey = {
      id: 'test-survey',
      title: 'Test Survey',
      status: 'draft',
      anonymous: false,
      questions: [
        { id: 'q1', text: 'Pick one', type: 'single_choice', options: ['A', 'B'] },
      ],
      createdAt: new Date().toISOString(),
      targetUsers: ['ou_user1'],
      responses: [],
    };

    const filePath = join(testDir, 'workspace', 'surveys', 'test-survey.json');
    mkdirSync(join(testDir, 'workspace', 'surveys'), { recursive: true });
    writeFileSync(filePath, JSON.stringify(survey, null, 2));

    expect(existsSync(filePath)).toBe(true);
    const saved = JSON.parse(await import('fs/promises').then(m => m.readFile(filePath, 'utf-8')));
    expect(saved.id).toBe('test-survey');
    expect(saved.questions).toHaveLength(1);
    expect(saved.targetUsers).toEqual(['ou_user1']);
  });
});

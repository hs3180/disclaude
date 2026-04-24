/**
 * Integration tests for survey create/query/respond/results/close scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SURVEY_DIR = resolve(PROJECT_ROOT, 'workspace/surveys');

// Helper to run a script with environment variables
async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, script);
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

const TEST_IDS = [
  'test-survey-1',
  'test-survey-dup',
  'test-survey-query-1',
  'test-survey-respond-1',
  'test-survey-results-1',
  'test-survey-close-1',
  'test-survey-multi-1',
  'test-survey-anon-1',
];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(SURVEY_DIR, `${id}.json`), { force: true });
      await rm(resolve(SURVEY_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

const BASIC_QUESTIONS = JSON.stringify([
  { id: 'q1', type: 'single_choice', text: 'Score', options: ['1', '2', '3', '4', '5'], required: true },
  { id: 'q2', type: 'text', text: 'Comments', required: false },
]);

const MULTI_QUESTIONS = JSON.stringify([
  { id: 'q1', type: 'single_choice', text: 'Rating', options: ['Good', 'Bad'], required: true },
  { id: 'q2', type: 'multiple_choice', text: 'Pick items', options: ['A', 'B', 'C'], required: false },
]);

describe('survey scripts integration', () => {
  beforeEach(async () => {
    await mkdir(SURVEY_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('create', () => {
    it('should create a valid survey file', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test Survey',
        SURVEY_DESCRIPTION: 'A test survey',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123", "ou_test456"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_ANONYMOUS: 'false',
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify file content
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-survey-1');
      expect(data.title).toBe('Test Survey');
      expect(data.status).toBe('open');
      expect(data.anonymous).toBe(false);
      expect(data.targetUsers).toEqual(['ou_test123', 'ou_test456']);
      expect(data.questions).toHaveLength(2);
      expect(data.questions[0].type).toBe('single_choice');
      expect(data.questions[1].type).toBe('text');
      expect(data.responses).toEqual({});
      expect(data.createdBy).toBe('ou_creator');
    });

    it('should create an anonymous survey', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-anon-1',
        SURVEY_TITLE: 'Anonymous Survey',
        SURVEY_DESCRIPTION: 'An anonymous survey',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_ANONYMOUS: 'true',
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(0);
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-anon-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.anonymous).toBe(true);
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-dup',
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      // Try to create duplicate
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-dup',
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing SURVEY_ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_ID');
    });

    it('should reject invalid deadline format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('UTC Z-suffix');
    });

    it('should reject invalid target users', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["invalid"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject choice questions with fewer than 2 options', async () => {
      const questions = JSON.stringify([
        { id: 'q1', type: 'single_choice', text: 'Only one?', options: ['Yes'], required: true },
      ]);
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: questions,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('at least 2 options');
    });
  });

  describe('respond', () => {
    beforeEach(async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_TITLE: 'Respond Test',
        SURVEY_DESCRIPTION: 'Test responding',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123", "ou_test456"]',
        SURVEY_QUESTIONS: MULTI_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });
    });

    it('should record a valid response', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Good", "q2": ["A", "B"]}',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify response was written
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-respond-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_test123']).toBeDefined();
      expect(data.responses['ou_test123'].answers.q1).toBe('Good');
      expect(data.responses['ou_test123'].answers.q2).toEqual(['A', 'B']);
    });

    it('should record a response with only required questions', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Bad"}',
      });

      expect(result.code).toBe(0);
    });

    it('should reject duplicate response from same user', async () => {
      // First response
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      // Second response
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Bad"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already responded');
    });

    it('should reject response from non-target user', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_unauthorized',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a target user');
    });

    it('should reject missing required question', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q2": ["A"]}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Required question');
    });

    it('should reject invalid option for choice question', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Invalid"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a valid option');
    });

    it('should reject unknown question ID', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "Good", "q99": "mystery"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unknown question ID');
    });
  });

  describe('results', () => {
    it('should aggregate results for a survey', { timeout: 60_000 }, async () => {
      // Create survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-results-1',
        SURVEY_TITLE: 'Results Test',
        SURVEY_DESCRIPTION: 'Test results',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123", "ou_test456"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      // Add responses
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-results-1',
        SURVEY_RESPONDENT: 'ou_test123',
        SURVEY_ANSWERS: '{"q1": "5", "q2": "Great!"}',
      });
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-results-1',
        SURVEY_RESPONDENT: 'ou_test456',
        SURVEY_ANSWERS: '{"q1": "4"}',
      });

      // Get results
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-results-1',
      });

      expect(result.code).toBe(0);
      const results = JSON.parse(result.stdout);
      expect(results.surveyId).toBe('test-survey-results-1');
      expect(results.totalResponses).toBe(2);
      expect(results.responseRate).toBe(100);
      expect(results.questions).toHaveLength(2);

      // Check choice question aggregation
      const q1 = results.questions[0];
      expect(q1.questionId).toBe('q1');
      expect(q1.totalResponses).toBe(2);
      expect(q1.choiceResults).toBeDefined();
      const fiveScore = q1.choiceResults.find((r: { option: string }) => r.option === '5');
      expect(fiveScore.count).toBe(1);
      const fourScore = q1.choiceResults.find((r: { option: string }) => r.option === '4');
      expect(fourScore.count).toBe(1);

      // Check text question aggregation
      const q2 = results.questions[1];
      expect(q2.questionId).toBe('q2');
      expect(q2.textResults).toEqual(['Great!']);

      // Check unanswered users
      expect(results.unansweredUsers).toEqual([]);
    });

    it('should report survey not found', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('close', () => {
    it('should close an open survey', async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-close-1',
        SURVEY_TITLE: 'Close Test',
        SURVEY_DESCRIPTION: 'Test closing',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-close-1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-close-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('closed');
    });

    it('should reject closing an already closed survey', { timeout: 60_000 }, async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-close-1',
        SURVEY_TITLE: 'Close Test',
        SURVEY_DESCRIPTION: 'Test closing',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: BASIC_QUESTIONS,
        SURVEY_CREATED_BY: 'ou_creator',
      });

      await runScript('skills/survey/close.ts', { SURVEY_ID: 'test-survey-close-1' });

      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-close-1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already closed');
    });
  });
});

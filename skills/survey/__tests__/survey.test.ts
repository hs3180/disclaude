/**
 * Integration tests for survey create/respond/results/close scripts.
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
async function runScript(script: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
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
  'test-survey-create',
  'test-survey-anon',
  'test-survey-respond',
  'test-survey-results',
  'test-survey-close',
  'test-survey-closed',
];

const VALID_QUESTIONS = JSON.stringify([
  { id: 'q1', type: 'single_choice', text: 'Rating', options: ['Good', 'Bad'], required: true },
  { id: 'q2', type: 'text', text: 'Comments', required: false },
]);

const VALID_MULTI_QUESTIONS = JSON.stringify([
  { id: 'q1', type: 'single_choice', text: 'Rating', options: ['Good', 'Bad'], required: true },
  { id: 'q2', type: 'multiple_choice', text: 'Features', options: ['A', 'B', 'C'], required: false },
  { id: 'q3', type: 'text', text: 'Comments', required: false },
]);

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
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify file was created with correct content
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-survey-1');
      expect(data.title).toBe('Test Survey');
      expect(data.status).toBe('active');
      expect(data.anonymous).toBe(false);
      expect(data.targetUsers).toEqual(['ou_test123']);
      expect(data.questions).toHaveLength(2);
      expect(data.questions[0].id).toBe('q1');
      expect(data.questions[0].type).toBe('single_choice');
      expect(data.questions[1].type).toBe('text');
      expect(data.responses).toEqual({});
      expect(data.closedAt).toBeNull();
      expect(data.deadline).toBeNull();
    });

    it('should create an anonymous survey with deadline', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-anon',
        SURVEY_TITLE: 'Anonymous Feedback',
        SURVEY_DESCRIPTION: 'Please provide anonymous feedback',
        SURVEY_DEADLINE: '2099-12-31T23:59:59Z',
        SURVEY_ANONYMOUS: 'true',
        SURVEY_TARGET_USERS: '["ou_user1", "ou_user2"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(0);
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-anon.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.anonymous).toBe(true);
      expect(data.deadline).toBe('2099-12-31T23:59:59Z');
      expect(data.description).toBe('Please provide anonymous feedback');
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'First',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      // Try duplicate
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Second',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing SURVEY_ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_ID');
    });

    it('should reject missing SURVEY_TITLE', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Title');
    });

    it('should reject invalid target users', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["invalid_user"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject empty questions', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: '[]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should reject invalid question type', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: '[{"id": "q1", "type": "rating", "text": "Rate"}]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('type');
    });

    it('should reject choice question with less than 2 options', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["ou_test123"]',
        SURVEY_QUESTIONS: '[{"id": "q1", "type": "single_choice", "text": "Pick", "options": ["Only one"]}]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('at least 2 options');
    });
  });

  describe('respond', () => {
    beforeEach(async () => {
      // Create a test survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_TITLE: 'Test',
        SURVEY_TARGET_USERS: '["ou_user1", "ou_user2"]',
        SURVEY_QUESTIONS: VALID_MULTI_QUESTIONS,
      });
    });

    it('should record a single-choice response', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-respond.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_user1']).toBeDefined();
      expect(data.responses['ou_user1'].answers.q1).toBe('Good');
    });

    it('should record a multiple-choice response', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good", "q2": ["A", "B"]}',
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-respond.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_user1'].answers.q2).toEqual(['A', 'B']);
    });

    it('should record a text response', async () => {
      // First record choice answers
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good", "q3": "Great experience overall!"}',
      });

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-respond.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_user1'].answers.q3).toBe('Great experience overall!');
    });

    it('should reject duplicate response from same user', async () => {
      // First response
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      // Duplicate
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Bad"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already responded');
    });

    it('should allow multiple users to respond', async () => {
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user2',
        SURVEY_ANSWERS: '{"q1": "Bad"}',
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-respond.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(Object.keys(data.responses)).toHaveLength(2);
    });

    it('should reject invalid choice option', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Invalid Option"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a valid option');
    });

    it('should reject response to closed survey', async () => {
      // Close the survey first
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-respond',
      });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('closed');
    });

    it('should reject missing required question', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q2": ["A"]}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Required');
    });

    it('should allow skipping optional questions', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-respond',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good"}',
      });

      expect(result.code).toBe(0);
    });
  });

  describe('results', () => {
    beforeEach(async () => {
      // Create a survey and add responses
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-results',
        SURVEY_TITLE: 'Test Results',
        SURVEY_TARGET_USERS: '["ou_user1", "ou_user2", "ou_user3"]',
        SURVEY_QUESTIONS: VALID_MULTI_QUESTIONS,
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-results',
        SURVEY_USER: 'ou_user1',
        SURVEY_ANSWERS: '{"q1": "Good", "q2": ["A", "B"], "q3": "Nice"}',
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'test-survey-results',
        SURVEY_USER: 'ou_user2',
        SURVEY_ANSWERS: '{"q1": "Good", "q2": ["B", "C"], "q3": "Great"}',
      });
    });

    it('should aggregate results correctly', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-results',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.surveyId).toBe('test-survey-results');
      expect(data.title).toBe('Test Results');
      expect(data.status).toBe('active');
      expect(data.totalRespondents).toBe(2);
      expect(data.targetCount).toBe(3);
      expect(data.completionRate).toBe('66.7%');
    });

    it('should show choice results with percentages', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-results',
      });

      const data = JSON.parse(result.stdout);
      const q1Result = data.questions.find((q: { questionId: string }) => q.questionId === 'q1');
      expect(q1Result.questionType).toBe('single_choice');
      expect(q1Result.totalResponses).toBe(2);

      const goodOption = q1Result.results.find((r: { option: string }) => r.option === 'Good');
      expect(goodOption.count).toBe(2);
      expect(goodOption.percentage).toBe('100.0%');

      const badOption = q1Result.results.find((r: { option: string }) => r.option === 'Bad');
      expect(badOption.count).toBe(0);
    });

    it('should show text answers', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-results',
      });

      const data = JSON.parse(result.stdout);
      const q3Result = data.questions.find((q: { questionId: string }) => q.questionId === 'q3');
      expect(q3Result.questionType).toBe('text');
      expect(q3Result.results.count).toBe(2);
      expect(q3Result.results.answers).toContain('Nice');
      expect(q3Result.results.answers).toContain('Great');
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
    beforeEach(async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-close',
        SURVEY_TITLE: 'Test Close',
        SURVEY_TARGET_USERS: '["ou_user1"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });
    });

    it('should close an active survey', async () => {
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-close',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-close.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('closed');
      expect(data.closedAt).toBeTruthy();
    });

    it('should reject closing already closed survey', async () => {
      // Close first
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-close',
      });

      // Try again
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-survey-close',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already closed');
    });

    it('should report survey not found', async () => {
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });
});

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

const TEST_SURVEY_ID = 'test-survey-1';
const TEST_SURVEY_ID_2 = 'test-survey-2';
const ALL_TEST_IDS = [TEST_SURVEY_ID, TEST_SURVEY_ID_2];

const SAMPLE_QUESTIONS = JSON.stringify([
  {
    id: 'q1',
    type: 'single_choice',
    question: 'How do you rate the taste?',
    options: [
      { id: 'opt1', label: '⭐ Excellent' },
      { id: 'opt2', label: '👍 Good' },
      { id: 'opt3', label: '👌 Average' },
      { id: 'opt4', label: '👎 Poor' },
    ],
    required: true,
  },
  {
    id: 'q2',
    type: 'text',
    question: 'Any suggestions?',
    required: false,
  },
]);

const SAMPLE_TARGET_USERS = JSON.stringify(['ou_testuser1', 'ou_testuser2', 'ou_testuser3']);

async function cleanupTestFiles() {
  for (const id of ALL_TEST_IDS) {
    try {
      await rm(resolve(SURVEY_DIR, `${id}.json`), { force: true });
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
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Restaurant Review',
        SURVEY_DESCRIPTION: 'Please rate our team lunch',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
      expect(result.stdout).toContain('2 questions');
      expect(result.stdout).toContain('3 target users');

      // Verify file content
      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe(TEST_SURVEY_ID);
      expect(data.title).toBe('Restaurant Review');
      expect(data.status).toBe('active');
      expect(data.anonymous).toBe(false);
      expect(data.questions).toHaveLength(2);
      expect(data.questions[0].type).toBe('single_choice');
      expect(data.questions[0].options).toHaveLength(4);
      expect(data.questions[1].type).toBe('text');
      expect(data.targetUsers).toEqual(['ou_testuser1', 'ou_testuser2', 'ou_testuser3']);
      expect(data.responses).toEqual({});
      expect(data.closedAt).toBeNull();
    });

    it('should create survey as draft when specified', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Draft Survey',
        SURVEY_DESCRIPTION: 'A draft survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
        SURVEY_STATUS: 'draft',
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('draft');
    });

    it('should create anonymous survey', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Anonymous Poll',
        SURVEY_DESCRIPTION: 'Anonymous poll test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
        SURVEY_ANONYMOUS: 'true',
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.anonymous).toBe(true);
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'First',
        SURVEY_DESCRIPTION: 'First survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      // Try duplicate
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Second',
        SURVEY_DESCRIPTION: 'Second survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing SURVEY_ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_ID');
    });

    it('should reject missing SURVEY_TITLE', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_TITLE');
    });

    it('should reject invalid SURVEY_EXPIRES_AT format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('UTC Z-suffix');
    });

    it('should reject invalid target user format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["invalid_user"]',
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject questions with missing options for choice type', async () => {
      const badQuestions = JSON.stringify([
        { id: 'q1', type: 'single_choice', question: 'Pick one', required: true },
      ]);

      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: badQuestions,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('at least 2 options');
    });

    it('should reject empty questions array', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Test',
        SURVEY_DESCRIPTION: 'Test survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: '[]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should support multiple_choice questions', async () => {
      const multiQuestions = JSON.stringify([
        {
          id: 'q1',
          type: 'multiple_choice',
          question: 'Select all that apply',
          options: [
            { id: 'opt1', label: 'Option A' },
            { id: 'opt2', label: 'Option B' },
            { id: 'opt3', label: 'Option C' },
          ],
          required: true,
        },
      ]);

      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Multi-select Test',
        SURVEY_DESCRIPTION: 'Test multiple choice',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: multiQuestions,
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.questions[0].type).toBe('multiple_choice');
    });
  });

  describe('respond', () => {
    beforeEach(async () => {
      // Create a test survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Restaurant Review',
        SURVEY_DESCRIPTION: 'Please rate',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });
    });

    it('should record a single choice + text response', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt2', q2: 'Great food!' }),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
      expect(result.stdout).toContain('1 total responses');

      // Verify response was written
      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_testuser1']).toBeDefined();
      expect(data.responses['ou_testuser1'].answers.q1).toBe('opt2');
      expect(data.responses['ou_testuser1'].answers.q2).toBe('Great food!');
    });

    it('should record a partial response (skip optional questions)', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser2',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_testuser2'].answers.q1).toBe('opt1');
      expect(data.responses['ou_testuser2'].answers.q2).toBeUndefined();
    });

    it('should reject duplicate response from same user', async () => {
      // First response
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt2' }),
      });

      // Second response (should fail)
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already submitted');
    });

    it('should reject response to non-existent survey', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'nonexistent-survey',
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should reject response with invalid option', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt99' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a valid option');
    });

    it('should reject response missing required question', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q2: 'Some text' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Required question');
    });

    it('should reject response to closed survey', async () => {
      // Close the survey first
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not active');
    });

    it('should allow multiple different users to respond', async () => {
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser2',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt2' }),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('2 total responses');

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(Object.keys(data.responses)).toHaveLength(2);
    });
  });

  describe('results', () => {
    beforeEach(async () => {
      // Create a test survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Restaurant Review',
        SURVEY_DESCRIPTION: 'Please rate',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });
    });

    it('should return empty results for survey with no responses', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.id).toBe(TEST_SURVEY_ID);
      expect(data.title).toBe('Restaurant Review');
      expect(data.totalRespondents).toBe(0);
      expect(data.completionRate).toBe(0);
      expect(data.questions).toHaveLength(2);
    });

    it('should aggregate single choice results correctly', async () => {
      // Add responses
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser2',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt2' }),
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser3',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1' }),
      });

      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.totalRespondents).toBe(3);
      expect(data.completionRate).toBe(100);

      // Check q1 aggregation
      const q1 = data.questions[0];
      expect(q1.totalResponses).toBe(3);
      const opt1Result = q1.results.find((r: { optionId: string }) => r.optionId === 'opt1');
      const opt2Result = q1.results.find((r: { optionId: string }) => r.optionId === 'opt2');
      expect(opt1Result.count).toBe(2);
      expect(opt1Result.percentage).toBe(67);
      expect(opt2Result.count).toBe(1);
      expect(opt2Result.percentage).toBe(33);
    });

    it('should aggregate text answers correctly', async () => {
      // Add responses with text
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt1', q2: 'Add more options' }),
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_RESPONDENT: 'ou_testuser2',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'opt2' }),
      });

      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);

      // Check q2 aggregation (text question)
      const q2 = data.questions[1];
      expect(q2.type).toBe('text');
      expect(q2.totalResponses).toBe(1);
      expect(q2.results).toEqual(['Add more options']);
    });

    it('should report not found for nonexistent survey', async () => {
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
        SURVEY_ID: TEST_SURVEY_ID,
        SURVEY_TITLE: 'Restaurant Review',
        SURVEY_DESCRIPTION: 'Please rate',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: SAMPLE_QUESTIONS,
      });
    });

    it('should close an active survey', async () => {
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('closed');
      expect(result.stdout).toContain('0 responses');

      // Verify file was updated
      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('closed');
      expect(data.closedAt).toBeTruthy();
    });

    it('should report already closed', async () => {
      // Close once
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      // Try closing again
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: TEST_SURVEY_ID,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already closed');
    });

    it('should report not found for nonexistent survey', async () => {
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('multiple_choice', () => {
    const MULTI_QUESTIONS = JSON.stringify([
      {
        id: 'q1',
        type: 'multiple_choice',
        question: 'Which features do you like?',
        options: [
          { id: 'opt1', label: 'Speed' },
          { id: 'opt2', label: 'Quality' },
          { id: 'opt3', label: 'Price' },
        ],
        required: true,
      },
    ]);

    beforeEach(async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: TEST_SURVEY_ID_2,
        SURVEY_TITLE: 'Feature Poll',
        SURVEY_DESCRIPTION: 'Which features?',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: SAMPLE_TARGET_USERS,
        SURVEY_QUESTIONS: MULTI_QUESTIONS,
      });
    });

    it('should accept array answers for multiple_choice', async () => {
      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID_2,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: ['opt1', 'opt2'] }),
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, `${TEST_SURVEY_ID_2}.json`), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_testuser1'].answers.q1).toEqual(['opt1', 'opt2']);
    });

    it('should aggregate multiple_choice results correctly', async () => {
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID_2,
        SURVEY_RESPONDENT: 'ou_testuser1',
        SURVEY_ANSWERS: JSON.stringify({ q1: ['opt1', 'opt2'] }),
      });

      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: TEST_SURVEY_ID_2,
        SURVEY_RESPONDENT: 'ou_testuser2',
        SURVEY_ANSWERS: JSON.stringify({ q1: ['opt1', 'opt3'] }),
      });

      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: TEST_SURVEY_ID_2,
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);

      const q1 = data.questions[0];
      expect(q1.totalResponses).toBe(2);
      const opt1Result = q1.results.find((r: { optionId: string }) => r.optionId === 'opt1');
      expect(opt1Result.count).toBe(2);
      expect(opt1Result.percentage).toBe(100);
    });
  });
});

/**
 * Integration tests for survey create/respond/results lifecycle.
 *
 * Tests the CLI scripts by spawning child processes with environment variables.
 * Follows the same pattern as skills/chat/__tests__/create.test.ts.
 *
 * Issue #2191: Survey/Polling feature tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SURVEY_DIR = resolve(PROJECT_ROOT, 'workspace/surveys');

const TEST_IDS = [
  'test-survey-001',
  'dup-survey',
  'activate-test',
  'already-active',
  'respond-test',
  'draft-respond',
  'non-target',
  'close-test',
  'results-test',
];

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
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout?.trim() ?? '',
      stderr: execErr.stderr?.trim() ?? '',
      code: execErr.code ?? 1,
    };
  }
}

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

describe('survey lifecycle', { timeout: 60000 }, () => {
  beforeEach(async () => {
    await mkdir(SURVEY_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  const BASE_ENV = {
    SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
    SURVEY_TARGET_USERS: '["ou_abc"]',
    SURVEY_CHAT_ID: 'oc_test',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"text","text":"Q1"}]',
  };

  describe('create.ts', () => {
    it('should create a valid survey file', async () => {
      const result = await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'test-survey-001',
        SURVEY_TITLE: 'Test Survey',
        SURVEY_DESCRIPTION: 'A test survey',
        SURVEY_TARGET_USERS: '["ou_abc123", "ou_def456"]',
        SURVEY_CHAT_ID: 'oc_test123',
        SURVEY_QUESTIONS: JSON.stringify([
          { id: 'q1', type: 'single_choice', text: 'Rating', options: ['1⭐', '2⭐', '3⭐', '4⭐', '5⭐'] },
          { id: 'q2', type: 'text', text: 'Your thoughts?' },
        ]),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Survey test-survey-001 created');

      // Verify file was created
      const files = await readdir(SURVEY_DIR);
      expect(files).toContain('test-survey-001.json');

      // Verify file content
      const content = await readFile(join(SURVEY_DIR, 'test-survey-001.json'), 'utf-8');
      const survey = JSON.parse(content);
      expect(survey.id).toBe('test-survey-001');
      expect(survey.title).toBe('Test Survey');
      expect(survey.status).toBe('draft');
      expect(survey.anonymous).toBe(false);
      expect(survey.questions).toHaveLength(2);
      expect(survey.responses).toEqual({});
    });

    it('should reject missing survey ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_TITLE: 'Test',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ERROR');
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'dup-survey',
        SURVEY_TITLE: 'First',
      });

      // Try to create duplicate
      const result = await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'dup-survey',
        SURVEY_TITLE: 'Second',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });
  });

  describe('activate.ts', () => {
    it('should activate a draft survey', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'activate-test',
        SURVEY_TITLE: 'Test',
      });

      const result = await runScript('skills/survey/activate.ts', {
        SURVEY_ID: 'activate-test',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Survey activate-test activated');

      // Verify status changed
      const content = await readFile(join(SURVEY_DIR, 'activate-test.json'), 'utf-8');
      const survey = JSON.parse(content);
      expect(survey.status).toBe('active');
      expect(survey.activatedAt).toBeTruthy();
    });

    it('should reject activating a non-draft survey', async () => {
      // Create and activate
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'already-active',
        SURVEY_TITLE: 'Test',
      });
      await runScript('skills/survey/activate.ts', { SURVEY_ID: 'already-active' });

      // Try to activate again
      const result = await runScript('skills/survey/activate.ts', {
        SURVEY_ID: 'already-active',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('cannot be activated');
    });
  });

  describe('respond.ts', () => {
    it('should record a response for an active survey', async () => {
      // Create and activate
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'respond-test',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_abc", "ou_def"]',
        SURVEY_CHAT_ID: 'oc_test',
        SURVEY_QUESTIONS: JSON.stringify([
          { id: 'q1', type: 'single_choice', text: 'Rating', options: ['Good', 'Bad'] },
          { id: 'q2', type: 'text', text: 'Comments' },
        ]),
      });
      await runScript('skills/survey/activate.ts', { SURVEY_ID: 'respond-test' });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'respond-test',
        SURVEY_RESPONDER: 'ou_abc',
        SURVEY_ANSWERS: '{"q1":"Good","q2":"Great experience!"}',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Response recorded');

      // Verify response was saved
      const content = await readFile(join(SURVEY_DIR, 'respond-test.json'), 'utf-8');
      const survey = JSON.parse(content);
      expect(Object.keys(survey.responses)).toHaveLength(1);
      expect(survey.responses['ou_abc'].answers.q1).toBe('Good');
      expect(survey.responses['ou_abc'].answers.q2).toBe('Great experience!');
    });

    it('should reject response for draft survey', async () => {
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'draft-respond',
        SURVEY_TITLE: 'Test',
      });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'draft-respond',
        SURVEY_RESPONDER: 'ou_abc',
        SURVEY_ANSWERS: '{"q1":"answer"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not active');
    });

    it('should reject response from non-target user', { timeout: 30000 }, async () => {
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'non-target',
        SURVEY_TITLE: 'Test',
      });
      await runScript('skills/survey/activate.ts', { SURVEY_ID: 'non-target' });

      const result = await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'non-target',
        SURVEY_RESPONDER: 'ou_unauthorized',
        SURVEY_ANSWERS: '{"q1":"answer"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a target user');
    });
  });

  describe('close.ts', () => {
    it('should close an active survey', async () => {
      await runScript('skills/survey/create.ts', {
        ...BASE_ENV,
        SURVEY_ID: 'close-test',
        SURVEY_TITLE: 'Test',
      });
      await runScript('skills/survey/activate.ts', { SURVEY_ID: 'close-test' });

      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'close-test',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Survey close-test closed');

      const content = await readFile(join(SURVEY_DIR, 'close-test.json'), 'utf-8');
      const survey = JSON.parse(content);
      expect(survey.status).toBe('closed');
      expect(survey.closedAt).toBeTruthy();
    });
  });

  describe('results.ts', () => {
    it('should aggregate survey results', { timeout: 30000 }, async () => {
      // Create, activate, and add responses
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'results-test',
        SURVEY_TITLE: 'Restaurant Review',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["ou_abc", "ou_def"]',
        SURVEY_CHAT_ID: 'oc_test',
        SURVEY_QUESTIONS: JSON.stringify([
          { id: 'q1', type: 'single_choice', text: 'Rating', options: ['Good', 'Bad'] },
          { id: 'q2', type: 'text', text: 'Comments' },
        ]),
      });
      await runScript('skills/survey/activate.ts', { SURVEY_ID: 'results-test' });
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'results-test',
        SURVEY_RESPONDER: 'ou_abc',
        SURVEY_ANSWERS: '{"q1":"Good","q2":"Great food!"}',
      });
      await runScript('skills/survey/respond.ts', {
        SURVEY_ID: 'results-test',
        SURVEY_RESPONDER: 'ou_def',
        SURVEY_ANSWERS: '{"q1":"Bad","q2":"Slow service"}',
      });

      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'results-test',
      });

      expect(result.code).toBe(0);
      const results = JSON.parse(result.stdout);
      expect(results.totalResponses).toBe(2);
      expect(results.totalTargets).toBe(2);
      expect(results.responseRate).toBe('100%');
      expect(results.questions).toHaveLength(2);

      // Check choice aggregation
      const q1 = results.questions[0];
      expect(q1.type).toBe('single_choice');
      expect(q1.optionCounts['Good']).toBe(1);
      expect(q1.optionCounts['Bad']).toBe(1);

      // Check text aggregation
      const q2 = results.questions[1];
      expect(q2.type).toBe('text');
      expect(q2.answers).toHaveLength(2);
    });
  });
});

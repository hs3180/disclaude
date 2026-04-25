/**
 * Integration tests for survey create/query/list/submit-response/results scripts.
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
  'test-survey-2',
  'test-survey-dup',
  'test-survey-query',
  'test-survey-list',
  'test-survey-submit',
  'test-survey-results',
  'test-survey-multi',
];

const VALID_QUESTIONS = JSON.stringify([
  { id: 'q1', type: 'single_choice', text: 'How satisfied are you?', options: ['Very', 'OK', 'Not great'] },
  { id: 'q2', type: 'multiple_choice', text: 'What do you like?', options: ['Speed', 'Quality'] },
  { id: 'q3', type: 'open_text', text: 'Comments?' },
]);

const VALID_USERS = JSON.stringify(['ou_alice', 'ou_bob']);

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
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
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
      expect(data.targetUsers).toEqual(['ou_alice', 'ou_bob']);
      expect(data.questions).toHaveLength(3);
      expect(data.questions[0].id).toBe('q1');
      expect(data.questions[0].type).toBe('single_choice');
      expect(data.questions[0].options).toEqual(['Very', 'OK', 'Not great']);
      expect(data.questions[2].type).toBe('open_text');
      expect(data.questions[2].options).toBeUndefined();
      expect(data.responses).toEqual({});
      expect(data.closedAt).toBeNull();
    });

    it('should create an anonymous survey', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-2',
        SURVEY_TITLE: 'Anonymous Survey',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_ANONYMOUS: 'true',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-2.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.anonymous).toBe(true);
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-dup',
        SURVEY_TITLE: 'First',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      // Try to create duplicate
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-dup',
        SURVEY_TITLE: 'Second',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing SURVEY_ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_ID');
    });

    it('should reject invalid expiresAt format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('UTC Z-suffix');
    });

    it('should reject invalid target user format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: '["invalid_user"]',
        SURVEY_QUESTIONS: VALID_QUESTIONS,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject questions without options for choice type', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: JSON.stringify([
          { id: 'q1', type: 'single_choice', text: 'Pick one' },
        ]),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('options');
    });

    it('should reject duplicate question IDs', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: JSON.stringify([
          { id: 'q1', type: 'single_choice', text: 'Q1', options: ['A', 'B'] },
          { id: 'q1', type: 'single_choice', text: 'Q1 dup', options: ['C', 'D'] },
        ]),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Duplicate');
    });

    it('should store originChatId when provided', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-survey-1',
        SURVEY_TITLE: 'Test',
        SURVEY_EXPIRES_AT: '2099-12-31T23:59:59Z',
        SURVEY_TARGET_USERS: VALID_USERS,
        SURVEY_QUESTIONS: VALID_QUESTIONS,
        SURVEY_ORIGIN_CHAT: 'oc_test_chat',
      });

      expect(result.code).toBe(0);
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.originChatId).toBe('oc_test_chat');
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Create a test survey file
      const surveyData = {
        id: 'test-survey-query',
        title: 'Query Test Survey',
        status: 'active',
        anonymous: false,
        createdAt: '2026-04-26T10:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        closedAt: null,
        questions: JSON.parse(VALID_QUESTIONS),
        targetUsers: ['ou_alice', 'ou_bob'],
        originChatId: null,
        responses: {},
      };
      await writeFile(resolve(SURVEY_DIR, 'test-survey-query.json'), JSON.stringify(surveyData, null, 2), 'utf-8');
    });

    it('should return survey file content', async () => {
      const result = await runScript('skills/survey/query.ts', {
        SURVEY_ID: 'test-survey-query',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.id).toBe('test-survey-query');
      expect(data.status).toBe('active');
      expect(data.title).toBe('Query Test Survey');
    });

    it('should report survey not found', async () => {
      const result = await runScript('skills/survey/query.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('submit-response', () => {
    beforeEach(async () => {
      const surveyData = {
        id: 'test-survey-submit',
        title: 'Submit Test Survey',
        status: 'active',
        anonymous: false,
        createdAt: '2026-04-26T10:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        closedAt: null,
        questions: JSON.parse(VALID_QUESTIONS),
        targetUsers: ['ou_alice', 'ou_bob'],
        originChatId: null,
        responses: {},
      };
      await writeFile(resolve(SURVEY_DIR, 'test-survey-submit.json'), JSON.stringify(surveyData, null, 2), 'utf-8');
    });

    it('should record a valid response', async () => {
      const result = await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_alice',
        SURVEY_ANSWERS: JSON.stringify({
          q1: 'Very',
          q2: ['Speed', 'Quality'],
          q3: 'Great work!',
        }),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify response was written
      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-submit.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_alice']).toBeDefined();
      expect(data.responses['ou_alice'].answers.q1).toBe('Very');
      expect(data.responses['ou_alice'].answers.q2).toEqual(['Speed', 'Quality']);
      expect(data.responses['ou_alice'].answers.q3).toBe('Great work!');
      expect(data.responses['ou_alice'].respondedAt).toBeTruthy();
    });

    it('should update existing response (upsert)', async () => {
      // First response
      await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_alice',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'OK' }),
      });

      // Updated response
      const result = await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_alice',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'Very' }),
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-survey-submit.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_alice'].answers.q1).toBe('Very');
    });

    it('should reject response from non-target user', async () => {
      const result = await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_unknown',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'Very' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a target user');
    });

    it('should reject invalid answer for single choice', async () => {
      const result = await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_alice',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'InvalidOption' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a valid option');
    });

    it('should reject response to closed survey', async () => {
      // Close the survey
      const surveyData = {
        id: 'test-survey-submit',
        title: 'Closed Survey',
        status: 'closed',
        anonymous: false,
        createdAt: '2026-04-26T10:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        closedAt: '2026-04-27T10:00:00Z',
        questions: JSON.parse(VALID_QUESTIONS),
        targetUsers: ['ou_alice', 'ou_bob'],
        originChatId: null,
        responses: {},
      };
      await writeFile(resolve(SURVEY_DIR, 'test-survey-submit.json'), JSON.stringify(surveyData, null, 2), 'utf-8');

      const result = await runScript('skills/survey/submit-response.ts', {
        SURVEY_ID: 'test-survey-submit',
        SURVEY_USER_ID: 'ou_alice',
        SURVEY_ANSWERS: JSON.stringify({ q1: 'Very' }),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('closed');
    });
  });

  describe('results', () => {
    beforeEach(async () => {
      const surveyData = {
        id: 'test-survey-results',
        title: 'Results Test Survey',
        status: 'active',
        anonymous: false,
        createdAt: '2026-04-26T10:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        closedAt: null,
        questions: [
          { id: 'q1', type: 'single_choice', text: 'Rate taste?', options: ['Good', 'Bad'] },
          { id: 'q2', type: 'multiple_choice', text: 'Pick areas', options: ['Speed', 'Quality'] },
          { id: 'q3', type: 'open_text', text: 'Comments?' },
        ],
        targetUsers: ['ou_alice', 'ou_bob'],
        originChatId: null,
        responses: {
          'ou_alice': {
            respondedAt: '2026-04-26T12:00:00Z',
            answers: { q1: 'Good', q2: ['Speed'], q3: 'Nice!' },
          },
          'ou_bob': {
            respondedAt: '2026-04-26T13:00:00Z',
            answers: { q1: 'Good', q2: ['Speed', 'Quality'] },
          },
        },
      };
      await writeFile(resolve(SURVEY_DIR, 'test-survey-results.json'), JSON.stringify(surveyData, null, 2), 'utf-8');
    });

    it('should aggregate results correctly', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-results',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);

      expect(data.surveyId).toBe('test-survey-results');
      expect(data.title).toBe('Results Test Survey');
      expect(data.totalTargetUsers).toBe(2);
      expect(data.totalResponses).toBe(2);
      expect(data.responseRate).toBe(100);

      // Check single choice question results
      const q1 = data.questions.find((q: { questionId: string }) => q.questionId === 'q1');
      expect(q1.type).toBe('single_choice');
      expect(q1.totalResponses).toBe(2);
      expect(q1.options).toEqual([
        { label: 'Good', count: 2, percentage: 100 },
        { label: 'Bad', count: 0, percentage: 0 },
      ]);

      // Check multiple choice question results
      const q2 = data.questions.find((q: { questionId: string }) => q.questionId === 'q2');
      expect(q2.type).toBe('multiple_choice');
      expect(q2.totalResponses).toBe(2);
      expect(q2.options).toEqual([
        { label: 'Speed', count: 2, percentage: 100 },
        { label: 'Quality', count: 1, percentage: 50 },
      ]);

      // Check open text question results
      const q3 = data.questions.find((q: { questionId: string }) => q.questionId === 'q3');
      expect(q3.type).toBe('open_text');
      expect(q3.totalResponses).toBe(1);
      expect(q3.responses).toEqual([
        { userId: 'ou_alice', text: 'Nice!' },
      ]);
    });

    it('should report survey not found', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('results with anonymous mode', () => {
    beforeEach(async () => {
      const surveyData = {
        id: 'test-survey-multi',
        title: 'Anonymous Results',
        status: 'active',
        anonymous: true,
        createdAt: '2026-04-26T10:00:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        closedAt: null,
        questions: [
          { id: 'q1', type: 'open_text', text: 'Your thoughts?' },
        ],
        targetUsers: ['ou_alice'],
        originChatId: null,
        responses: {
          'ou_alice': {
            respondedAt: '2026-04-26T12:00:00Z',
            answers: { q1: 'Secret feedback' },
          },
        },
      };
      await writeFile(resolve(SURVEY_DIR, 'test-survey-multi.json'), JSON.stringify(surveyData, null, 2), 'utf-8');
    });

    it('should mask user IDs in anonymous mode', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-survey-multi',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);

      const q1 = data.questions[0];
      expect(q1.responses[0].userId).toBe('anonymous');
      expect(q1.responses[0].text).toBe('Secret feedback');
    });
  });
});

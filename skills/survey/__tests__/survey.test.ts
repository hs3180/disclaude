/**
 * Integration tests for survey create/record-response/results/list/close scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  'test-create-1', 'test-create-anon', 'test-response-1',
  'test-results-1', 'test-list-a', 'test-list-b',
  'test-close-1',
];

const TEST_SURVEY = {
  title: 'Test Survey',
  description: 'A test survey',
  anonymous: 'false',
  targets: '["ou_test001", "ou_test002", "ou_test003"]',
  questions: JSON.stringify([
    { text: 'How do you rate this?', options: ['Good', 'OK', 'Bad'] },
    { text: 'Would you recommend?', options: ['Yes', 'No'] },
  ]),
  deadline: '2099-12-31T23:59:59Z',
  chatId: 'oc_testchat',
};

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
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_DESCRIPTION: TEST_SURVEY.description,
        SURVEY_ANONYMOUS: TEST_SURVEY.anonymous,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
        SURVEY_CHAT_ID: TEST_SURVEY.chatId,
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.survey.id).toBe('test-create-1');
      expect(output.survey.questions).toBe(2);
      expect(output.survey.targets).toBe(3);

      // Verify file content
      const content = await readFile(resolve(SURVEY_DIR, 'test-create-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-create-1');
      expect(data.status).toBe('open');
      expect(data.title).toBe('Test Survey');
      expect(data.anonymous).toBe(false);
      expect(data.questions).toHaveLength(2);
      expect(data.questions[0].type).toBe('single_choice');
      expect(data.questions[0].options).toEqual(['Good', 'OK', 'Bad']);
      expect(data.targets).toEqual(['ou_test001', 'ou_test002', 'ou_test003']);
      expect(data.chatId).toBe('oc_testchat');
      expect(data.responses).toEqual({});
    });

    it('should create an anonymous survey', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-anon',
        SURVEY_TITLE: 'Anonymous Survey',
        SURVEY_ANONYMOUS: 'true',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-create-anon.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.anonymous).toBe(true);
    });

    it('should reject duplicate survey ID', async () => {
      // Create first
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      // Try duplicate
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing SURVEY_ID', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_ID');
    });

    it('should reject missing title', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SURVEY_TITLE');
    });

    it('should reject invalid targets format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: '["invalid_id"]',
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject questions with fewer than 2 options', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: JSON.stringify([{ text: 'Pick one', options: ['Only one'] }]),
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('at least 2 options');
    });

    it('should reject invalid deadline format', async () => {
      const result = await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-create-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: '2099-12-31',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('UTC Z-suffix');
    });
  });

  describe('record-response', () => {
    beforeEach(async () => {
      // Create a test survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-response-1',
        SURVEY_TITLE: TEST_SURVEY.title,
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });
    });

    it('should record a response to an open survey', async () => {
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '1',
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.survey.optionText).toBe('OK');

      // Verify response in file
      const content = await readFile(resolve(SURVEY_DIR, 'test-response-1.json'), 'utf-8');
      const data = JSON.parse(content);
      const key = 'ou_test001:0';
      expect(data.responses[key]).toBeDefined();
      expect(data.responses[key].optionIndex).toBe(1);
      expect(data.responses[key].responder).toBe('ou_test001');
    });

    it('should allow changing a response (last wins)', async () => {
      // First response
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });

      // Change response
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '2',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Overwriting');

      // Verify last response wins
      const content = await readFile(resolve(SURVEY_DIR, 'test-response-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_test001:0'].optionIndex).toBe(2);
    });

    it('should allow responding to multiple questions', async () => {
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });

      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '1',
        OPTION_INDEX: '1',
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(SURVEY_DIR, 'test-response-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.responses['ou_test001:0']).toBeDefined();
      expect(data.responses['ou_test001:1']).toBeDefined();
    });

    it('should reject response for non-target user', async () => {
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_unknown',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not a target');
    });

    it('should reject response for invalid question index', async () => {
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '99',
        OPTION_INDEX: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('QUESTION_INDEX');
    });

    it('should reject response for invalid option index', async () => {
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-response-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '99',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OPTION_INDEX');
    });

    it('should reject response to non-existent survey', async () => {
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'nonexistent',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('results', () => {
    beforeEach(async () => {
      // Create a test survey
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-results-1',
        SURVEY_TITLE: 'Results Test',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      // Add some responses
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-results-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-results-1',
        RESPONDER: 'ou_test002',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-results-1',
        RESPONDER: 'ou_test003',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '1',
      });
      await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-results-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '1',
        OPTION_INDEX: '0',
      });
    }, 60_000);

    it('should return aggregated results', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'test-results-1',
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);
      expect(output.survey.id).toBe('test-results-1');
      expect(output.survey.title).toBe('Results Test');
      expect(output.survey.totalResponders).toBe(3);
      expect(output.results).toHaveLength(2);

      // Q0: Good=2 (67%), OK=1 (33%), Bad=0 (0%)
      const q0 = output.results[0];
      expect(q0.question).toBe('How do you rate this?');
      expect(q0.totalVotes).toBe(3);
      expect(q0.options[0].text).toBe('Good');
      expect(q0.options[0].votes).toBe(2);
      expect(q0.options[0].percentage).toBe(67);
      expect(q0.options[1].votes).toBe(1);
      expect(q0.options[1].percentage).toBe(33);
      expect(q0.options[2].votes).toBe(0);

      // Q1: Yes=1, No=0
      const q1 = output.results[1];
      expect(q1.totalVotes).toBe(1);
      expect(q1.options[0].votes).toBe(1);
      expect(q1.options[1].votes).toBe(0);
    });

    it('should report not found for non-existent survey', async () => {
      const result = await runScript('skills/survey/results.ts', {
        SURVEY_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      // Create two test surveys
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-list-a',
        SURVEY_TITLE: 'Survey A',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });

      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-list-b',
        SURVEY_TITLE: 'Survey B',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: '2020-01-01T00:00:00Z', // Already expired
      });
    });

    it('should list all surveys', async () => {
      const result = await runScript('skills/survey/list.ts', {});

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      const ourSurveys = output.filter((s: { id: string }) => s.id.startsWith('test-list-'));
      expect(ourSurveys).toHaveLength(2);
    });

    it('should filter by status', async () => {
      const result = await runScript('skills/survey/list.ts', {
        SURVEY_STATUS: 'open',
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      const openSurveys = output.filter((s: { id: string }) => s.id.startsWith('test-list-'));
      expect(openSurveys).toHaveLength(1);
      expect(openSurveys[0].id).toBe('test-list-a');
    });

    it('should show expired surveys', async () => {
      const result = await runScript('skills/survey/list.ts', {
        SURVEY_STATUS: 'expired',
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      const expiredSurveys = output.filter((s: { id: string }) => s.id.startsWith('test-list-'));
      expect(expiredSurveys).toHaveLength(1);
      expect(expiredSurveys[0].id).toBe('test-list-b');
    });
  });

  describe('close', () => {
    beforeEach(async () => {
      await runScript('skills/survey/create.ts', {
        SURVEY_ID: 'test-close-1',
        SURVEY_TITLE: 'Close Test',
        SURVEY_TARGETS: TEST_SURVEY.targets,
        SURVEY_QUESTIONS: TEST_SURVEY.questions,
        SURVEY_DEADLINE: TEST_SURVEY.deadline,
      });
    });

    it('should close an open survey', async () => {
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-close-1',
      });

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.success).toBe(true);

      // Verify status
      const content = await readFile(resolve(SURVEY_DIR, 'test-close-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('closed');
    });

    it('should reject closing already closed survey', async () => {
      // Close first
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-close-1',
      });

      // Try to close again
      const result = await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-close-1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already');
    });

    it('should reject responses to closed survey', async () => {
      // Close the survey
      await runScript('skills/survey/close.ts', {
        SURVEY_ID: 'test-close-1',
      });

      // Try to respond
      const result = await runScript('skills/survey/record-response.ts', {
        SURVEY_ID: 'test-close-1',
        RESPONDER: 'ou_test001',
        QUESTION_INDEX: '0',
        OPTION_INDEX: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('closed');
    });
  });
});

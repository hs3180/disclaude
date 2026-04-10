/**
 * Tests for survey scripts (create, respond, results).
 *
 * Run: npx tsx scripts/survey/__tests__/survey.test.ts
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

const TEST_DIR = resolve('workspace/surveys-test');
const SCRIPTS_DIR = resolve('scripts/survey');

// Helper to run a script with env vars
function runScript(script: string, env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`npx tsx ${script}`, {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

let passed = 0;
let failed = 0;
const testCases: { name: string; fn: () => Promise<void> }[] = [];

function test(name: string, fn: () => Promise<void>) {
  testCases.push({ name, fn });
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

// ---- Tests ----

test('create: should create a valid survey file', async () => {
  const env = {
    SURVEY_TITLE: 'Test Survey',
    SURVEY_QUESTIONS: JSON.stringify([
      { id: 'q1', type: 'single_choice', question: 'Pick one', options: ['A', 'B', 'C'] },
      { id: 'q2', type: 'text', question: 'Say something' },
    ]),
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_test1", "ou_test2"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  // We can't easily redirect the survey dir for tests, so just test validation
  const result = runScript(join(SCRIPTS_DIR, 'create.ts'), env);
  assert(result.exitCode === 0, `Expected exit code 0, got ${result.exitCode}. stderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout);
  assert(output.id.startsWith('survey-'), `Survey ID should start with 'survey-', got ${output.id}`);
  assert(output.status === 'created', `Expected status 'created', got ${output.status}`);

  // Verify the file was created
  const filePath = join('workspace/surveys', `${output.id}.json`);
  const content = await readFile(filePath, 'utf-8');
  const survey = JSON.parse(content);
  assert(survey.title === 'Test Survey', `Title mismatch`);
  assert(survey.questions.length === 2, `Expected 2 questions`);
  assert(survey.anonymous === false, `Expected anonymous=false by default`);
  assert(survey.status === 'active', `Expected status 'active'`);

  // Cleanup
  await rm(filePath, { force: true });
});

test('create: should reject empty title', async () => {
  const env = {
    SURVEY_TITLE: '',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"text","question":"Q?"}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_test"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const result = runScript(join(SCRIPTS_DIR, 'create.ts'), env);
  assert(result.exitCode === 1, `Expected exit code 1`);
  assert(result.stderr.includes('SURVEY_TITLE'), `Error should mention SURVEY_TITLE`);
});

test('create: should reject invalid questions', async () => {
  const env = {
    SURVEY_TITLE: 'Bad Questions',
    SURVEY_QUESTIONS: '[]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_test"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const result = runScript(join(SCRIPTS_DIR, 'create.ts'), env);
  assert(result.exitCode === 1, `Expected exit code 1`);
  assert(result.stderr.includes('non-empty'), `Error should mention non-empty`);
});

test('create: should support anonymous mode', async () => {
  const env = {
    SURVEY_TITLE: 'Anonymous Survey',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"single_choice","question":"Rate","options":["1","2","3"]}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_ANONYMOUS: 'true',
    SURVEY_TARGETS: '["ou_test"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const result = runScript(join(SCRIPTS_DIR, 'create.ts'), env);
  assert(result.exitCode === 0, `Expected exit code 0. stderr: ${result.stderr}`);

  const output = JSON.parse(result.stdout);
  const filePath = join('workspace/surveys', `${output.id}.json`);
  const content = await readFile(filePath, 'utf-8');
  const survey = JSON.parse(content);
  assert(survey.anonymous === true, `Expected anonymous=true`);

  await rm(filePath, { force: true });
});

test('respond: should record a valid response', async () => {
  // First create a survey
  const createEnv = {
    SURVEY_TITLE: 'Respond Test',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"single_choice","question":"Pick","options":["X","Y"]},{"id":"q2","type":"text","question":"Text"}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_responder"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const createResult = runScript(join(SCRIPTS_DIR, 'create.ts'), createEnv);
  assert(createResult.exitCode === 0, `Create failed: ${createResult.stderr}`);
  const surveyId = JSON.parse(createResult.stdout).id;

  // Record response for q1
  const respondEnv = {
    SURVEY_ID: surveyId,
    SURVEY_RESPONDER: 'ou_responder',
    SURVEY_QUESTION_ID: 'q1',
    SURVEY_ANSWER: 'X',
  };

  const respondResult = runScript(join(SCRIPTS_DIR, 'respond.ts'), respondEnv);
  assert(respondResult.exitCode === 0, `Respond failed: ${respondResult.stderr}`);

  const output = JSON.parse(respondResult.stdout);
  assert(output.answeredAll === false, `Should not be completed yet`);
  assert(output.totalResponses === 1, `Expected 1 response`);

  // Record response for q2
  const respondEnv2 = {
    SURVEY_ID: surveyId,
    SURVEY_RESPONDER: 'ou_responder',
    SURVEY_QUESTION_ID: 'q2',
    SURVEY_ANSWER: 'Some text answer',
  };

  const respondResult2 = runScript(join(SCRIPTS_DIR, 'respond.ts'), respondEnv2);
  assert(respondResult2.exitCode === 0, `Respond 2 failed: ${respondResult2.stderr}`);

  const output2 = JSON.parse(respondResult2.stdout);
  assert(output2.answeredAll === true, `Should be completed`);
  assert(output2.completedResponses === 1, `Expected 1 completed`);

  // Cleanup
  await rm(join('workspace/surveys', `${surveyId}.json`), { force: true });
});

test('respond: should reject invalid choice answer', async () => {
  // Create a survey
  const createEnv = {
    SURVEY_TITLE: 'Invalid Answer Test',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"single_choice","question":"Pick","options":["A","B"]}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_responder"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const createResult = runScript(join(SCRIPTS_DIR, 'create.ts'), createEnv);
  const surveyId = JSON.parse(createResult.stdout).id;

  // Try invalid answer
  const respondEnv = {
    SURVEY_ID: surveyId,
    SURVEY_RESPONDER: 'ou_responder',
    SURVEY_QUESTION_ID: 'q1',
    SURVEY_ANSWER: 'INVALID_OPTION',
  };

  const result = runScript(join(SCRIPTS_DIR, 'respond.ts'), respondEnv);
  assert(result.exitCode === 1, `Expected exit code 1`);
  assert(result.stderr.includes('Invalid answer'), `Error should mention invalid answer`);

  await rm(join('workspace/surveys', `${surveyId}.json`), { force: true });
});

test('respond: should reject non-existent survey', async () => {
  const env = {
    SURVEY_ID: 'survey-nonexistent',
    SURVEY_RESPONDER: 'ou_responder',
    SURVEY_QUESTION_ID: 'q1',
    SURVEY_ANSWER: 'test',
  };

  const result = runScript(join(SCRIPTS_DIR, 'respond.ts'), env);
  assert(result.exitCode === 1, `Expected exit code 1`);
  assert(result.stderr.includes('not found'), `Error should mention not found`);
});

test('results: should aggregate choice and text results', async () => {
  // Create a survey
  const createEnv = {
    SURVEY_TITLE: 'Results Test',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"single_choice","question":"Pick","options":["A","B"]},{"id":"q2","type":"text","question":"Comment"}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_user1", "ou_user2"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const createResult = runScript(join(SCRIPTS_DIR, 'create.ts'), createEnv);
  const surveyId = JSON.parse(createResult.stdout).id;

  // Add responses from two users
  for (const [user, q1answer, q2answer] of [
    ['ou_user1', 'A', 'Great'],
    ['ou_user2', 'B', 'Not great'],
  ] as const) {
    for (const [qid, answer] of [['q1', q1answer], ['q2', q2answer]] as const) {
      runScript(join(SCRIPTS_DIR, 'respond.ts'), {
        SURVEY_ID: surveyId,
        SURVEY_RESPONDER: user,
        SURVEY_QUESTION_ID: qid,
        SURVEY_ANSWER: answer,
      });
    }
  }

  // Get results
  const resultsEnv = { SURVEY_ID: surveyId };
  const resultsResult = runScript(join(SCRIPTS_DIR, 'results.ts'), resultsEnv);
  assert(resultsResult.exitCode === 0, `Results failed: ${resultsResult.stderr}`);

  const results = JSON.parse(resultsResult.stdout);
  assert(results.title === 'Results Test', `Title mismatch`);
  assert(results.totalResponded === 2, `Expected 2 responded`);
  assert(results.completedResponses === 2, `Expected 2 completed`);
  assert(results.questions.length === 2, `Expected 2 questions`);

  // Check choice question
  const q1 = results.questions[0];
  assert(q1.type === 'single_choice', `Expected single_choice`);
  assert(q1.totalResponses === 2, `Expected 2 responses for q1`);
  assert(q1.choiceResults.length === 2, `Expected 2 choice results`);

  // Check text question
  const q2 = results.questions[1];
  assert(q2.type === 'text', `Expected text`);
  assert(q2.totalResponses === 2, `Expected 2 responses for q2`);
  assert(q2.textResponses.includes('Great'), `Should include 'Great'`);
  assert(q2.textResponses.includes('Not great'), `Should include 'Not great'`);

  await rm(join('workspace/surveys', `${surveyId}.json`), { force: true });
});

test('results: should handle empty responses', async () => {
  const createEnv = {
    SURVEY_TITLE: 'Empty Results',
    SURVEY_QUESTIONS: '[{"id":"q1","type":"single_choice","question":"Pick","options":["A","B"]}]',
    SURVEY_DEADLINE: '2026-12-31T23:59:59Z',
    SURVEY_TARGETS: '["ou_user1"]',
    SURVEY_CREATOR: 'ou_creator',
  };

  const createResult = runScript(join(SCRIPTS_DIR, 'create.ts'), createEnv);
  const surveyId = JSON.parse(createResult.stdout).id;

  const resultsResult = runScript(join(SCRIPTS_DIR, 'results.ts'), { SURVEY_ID: surveyId });
  assert(resultsResult.exitCode === 0, `Results failed: ${resultsResult.stderr}`);

  const results = JSON.parse(resultsResult.stdout);
  assert(results.totalResponded === 0, `Expected 0 responded`);
  assert(results.questions[0].totalResponses === 0, `Expected 0 responses for q1`);

  await rm(join('workspace/surveys', `${surveyId}.json`), { force: true });
});

// ---- Runner ----

async function run() {
  console.log(`Running ${testCases.length} survey tests...\n`);

  for (const tc of testCases) {
    try {
      await tc.fn();
      console.log(`  ✅ ${tc.name}`);
      passed++;
    } catch (err) {
      console.log(`  ❌ ${tc.name}`);
      console.log(`     ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  process.exit(failed > 0 ? 1 : 0);
}

run();

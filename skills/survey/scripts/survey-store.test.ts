import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, 'survey-store.mjs');
const TEST_DIR = join(__dirname, '__test_surveys__');

function runCmd(...args: string[]): string {
  return execSync(`node "${SCRIPT_PATH}" ${args.map(a => `"${a}"`).join(' ')}`, {
    cwd: __dirname,
    env: { ...process.env },
    encoding: 'utf-8',
    // The script uses process.cwd()/workspace/data/surveys but we need to adjust
    // since the script uses process.cwd() which is the test runner's cwd
  }).trim();
}

// Override the surveys directory for testing
function runCmdWithTestDir(...args: string[]): string {
  // Create a temp workspace structure
  const testWorkspace = join(TEST_DIR, 'workspace', 'data', 'surveys');
  mkdirSync(testWorkspace, { recursive: true });

  try {
    const stdout = execSync(
      `cd "${TEST_DIR}" && node "${SCRIPT_PATH}" ${args.map(a => `'${a}'`).join(' ')}`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ).trim();
    return stdout;
  } catch (e: any) {
    // Script exits with code 1 on error but still outputs JSON to stderr
    const stderr = (e.stderr || '').trim();
    const stdout = (e.stdout || '').trim();
    if (stderr) return stderr;
    if (stdout) return stdout;
    throw e;
  }
}

describe('survey-store', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'workspace', 'data', 'surveys'), { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('create', () => {
    it('should create a new survey', () => {
      const result = JSON.parse(runCmdWithTestDir(
        'create',
        'survey-test001',
        'What is your favorite color?',
        JSON.stringify(['Red', 'Blue', 'Green']),
        'oc_test_chat',
        'ou_test_user'
      ));

      expect(result.success).toBe(true);
      expect(result.survey.id).toBe('survey-test001');
      expect(result.survey.question).toBe('What is your favorite color?');
      expect(result.survey.options).toHaveLength(3);
      expect(result.survey.options[0].label).toBe('Red');
      expect(result.survey.options[0].value).toBe('opt_a');
      expect(result.survey.options[1].label).toBe('Blue');
      expect(result.survey.options[1].value).toBe('opt_b');
      expect(result.survey.options[2].label).toBe('Green');
      expect(result.survey.options[2].value).toBe('opt_c');
      expect(result.survey.status).toBe('active');
      expect(result.survey.chatId).toBe('oc_test_chat');
      expect(result.survey.createdBy).toBe('ou_test_user');
    });

    it('should persist survey to file', () => {
      runCmdWithTestDir(
        'create',
        'survey-test002',
        'Test question',
        JSON.stringify(['A', 'B']),
        'oc_chat',
        'ou_user'
      );

      const filePath = join(TEST_DIR, 'workspace', 'data', 'surveys', 'survey-test002.json');
      expect(existsSync(filePath)).toBe(true);

      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(data.id).toBe('survey-test002');
      expect(data.question).toBe('Test question');
    });

    it('should accept options with explicit values', () => {
      const options = [
        { label: 'Option X', value: 'opt_x' },
        { label: 'Option Y', value: 'opt_y' },
      ];

      const result = JSON.parse(runCmdWithTestDir(
        'create',
        'survey-test003',
        'Custom options test',
        JSON.stringify(options),
        'oc_chat',
        'ou_user'
      ));

      expect(result.success).toBe(true);
      expect(result.survey.options[0].label).toBe('Option X');
      expect(result.survey.options[0].value).toBe('opt_x');
    });
  });

  describe('vote', () => {
    beforeEach(() => {
      runCmdWithTestDir(
        'create',
        'survey-vote-test',
        'Vote test question',
        JSON.stringify(['Pizza', 'Sushi', 'Tacos']),
        'oc_chat',
        'ou_creator'
      );
    });

    it('should record a vote', () => {
      const result = JSON.parse(runCmdWithTestDir(
        'vote',
        'survey-vote-test',
        'ou_user1',
        'opt_a',
        'Pizza'
      ));

      expect(result.success).toBe(true);
      expect(result.isUpdate).toBe(false);
      expect(result.totalVotes).toBe(1);
      expect(result.optionCounts.Pizza).toBe(1);
    });

    it('should allow user to change their vote', () => {
      runCmdWithTestDir('vote', 'survey-vote-test', 'ou_user1', 'opt_a', 'Pizza');
      const result = JSON.parse(runCmdWithTestDir(
        'vote',
        'survey-vote-test',
        'ou_user1',
        'opt_b',
        'Sushi'
      ));

      expect(result.success).toBe(true);
      expect(result.isUpdate).toBe(true);
      expect(result.totalVotes).toBe(1); // Still 1 because it's the same user
      expect(result.optionCounts.Sushi).toBe(1);
      expect(result.optionCounts.Pizza).toBe(0);
    });

    it('should track multiple voters', () => {
      runCmdWithTestDir('vote', 'survey-vote-test', 'ou_user1', 'opt_a', 'Pizza');
      runCmdWithTestDir('vote', 'survey-vote-test', 'ou_user2', 'opt_a', 'Pizza');
      const result = JSON.parse(runCmdWithTestDir(
        'vote', 'survey-vote-test', 'ou_user3', 'opt_c', 'Tacos'
      ));

      expect(result.totalVotes).toBe(3);
      expect(result.optionCounts.Pizza).toBe(2);
      expect(result.optionCounts.Tacos).toBe(1);
    });

    it('should reject vote on closed survey', () => {
      runCmdWithTestDir('close', 'survey-vote-test');

      const result = JSON.parse(
        runCmdWithTestDir('vote', 'survey-vote-test', 'ou_user1', 'opt_a', 'Pizza')
      );

      // The script exits with error, but in this test it returns the error JSON
      expect(result.error).toBe('SURVEY_CLOSED');
    });
  });

  describe('results', () => {
    it('should return results with counts and percentages', () => {
      runCmdWithTestDir(
        'create',
        'survey-results-test',
        'Results test',
        JSON.stringify(['A', 'B', 'C']),
        'oc_chat',
        'ou_creator'
      );

      runCmdWithTestDir('vote', 'survey-results-test', 'ou_user1', 'opt_a', 'A');
      runCmdWithTestDir('vote', 'survey-results-test', 'ou_user2', 'opt_a', 'A');
      runCmdWithTestDir('vote', 'survey-results-test', 'ou_user3', 'opt_b', 'B');

      const result = JSON.parse(runCmdWithTestDir('results', 'survey-results-test'));

      expect(result.success).toBe(true);
      expect(result.totalVotes).toBe(3);
      expect(result.optionCounts.A).toBe(2);
      expect(result.optionCounts.B).toBe(1);
      expect(result.optionCounts.C).toBe(0);
      expect(result.optionPercentages.A).toBe(67);
      expect(result.optionPercentages.B).toBe(33);
      expect(result.optionPercentages.C).toBe(0);
      expect(result.bars).toBeDefined();
      expect(result.survey.status).toBe('active');
    });

    it('should handle empty survey with no votes', () => {
      runCmdWithTestDir(
        'create',
        'survey-empty-test',
        'Empty test',
        JSON.stringify(['X', 'Y']),
        'oc_chat',
        'ou_creator'
      );

      const result = JSON.parse(runCmdWithTestDir('results', 'survey-empty-test'));

      expect(result.totalVotes).toBe(0);
      expect(result.optionPercentages.X).toBe(0);
      expect(result.optionPercentages.Y).toBe(0);
    });
  });

  describe('close', () => {
    it('should close an active survey', () => {
      runCmdWithTestDir(
        'create',
        'survey-close-test',
        'Close test',
        JSON.stringify(['Yes', 'No']),
        'oc_chat',
        'ou_creator'
      );

      const result = JSON.parse(runCmdWithTestDir('close', 'survey-close-test'));

      expect(result.success).toBe(true);
      expect(result.closedAt).toBeTruthy();

      // Verify persisted state
      const filePath = join(TEST_DIR, 'workspace', 'data', 'surveys', 'survey-close-test.json');
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(data.status).toBe('closed');
    });

    it('should reject closing already closed survey', () => {
      runCmdWithTestDir(
        'create',
        'survey-close2-test',
        'Close test 2',
        JSON.stringify(['A']),
        'oc_chat',
        'ou_creator'
      );
      runCmdWithTestDir('close', 'survey-close2-test');

      const result = JSON.parse(runCmdWithTestDir('close', 'survey-close2-test'));
      expect(result.error).toBe('ALREADY_CLOSED');
    });
  });

  describe('list', () => {
    it('should list all surveys', () => {
      runCmdWithTestDir(
        'create', 'survey-list1', 'Q1', JSON.stringify(['A']), 'oc_chat', 'ou_creator'
      );
      runCmdWithTestDir(
        'create', 'survey-list2', 'Q2', JSON.stringify(['B']), 'oc_chat', 'ou_creator'
      );

      const result = JSON.parse(runCmdWithTestDir('list'));

      expect(result.success).toBe(true);
      expect(result.surveys).toHaveLength(2);
      expect(result.surveys.some(s => s.id === 'survey-list1')).toBe(true);
      expect(result.surveys.some(s => s.id === 'survey-list2')).toBe(true);
    });

    it('should return empty list when no surveys', () => {
      const testDir2 = join(TEST_DIR, 'empty_test');
      mkdirSync(join(testDir2, 'workspace', 'data', 'surveys'), { recursive: true });

      const result = JSON.parse(execSync(
        `cd "${testDir2}" && node "${SCRIPT_PATH}" list`,
        { encoding: 'utf-8' }
      ).trim());

      expect(result.success).toBe(true);
      expect(result.surveys).toHaveLength(0);

      rmSync(testDir2, { recursive: true, force: true });
    });
  });
});

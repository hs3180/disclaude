/**
 * Tests for survey/poll tools.
 *
 * Issue #2191: Survey/Polling feature (Phase 1).
 *
 * @module mcp-server/tools/survey.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  create_poll,
  record_poll_vote,
  get_poll_results,
  close_poll,
  list_polls,
  type PollEntry,
} from './survey.js';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Use a temporary directory for test poll files
const TEST_DIR = join(tmpdir(), `disclaude-survey-test-${process.pid}-${Date.now()}`);

// Mock IPC to avoid needing a real Primary Node
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    getIpcClient: () => ({
      sendInteractive: vi.fn().mockResolvedValue({
        success: true,
        messageId: 'test-msg-id',
      }),
    }),
  };
});

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn().mockResolvedValue(true),
  getIpcErrorMessage: vi.fn().mockReturnValue('IPC error'),
}));

vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn().mockReturnValue(null),
}));

beforeEach(() => {
  // Set test workspace directory
  process.env.WORKSPACE_DIR = TEST_DIR;
  // Clean up and create test directory
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Clean up
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  delete process.env.WORKSPACE_DIR;
});

describe('create_poll', () => {
  it('should create a poll with valid parameters', async () => {
    const result = await create_poll({
      question: '你更喜欢哪个编程语言？',
      options: [
        { text: 'TypeScript', value: 'ts' },
        { text: 'Python', value: 'py' },
        { text: 'Go', value: 'go' },
      ],
      chatId: 'oc_test123',
    });

    expect(result.success).toBe(true);
    expect(result.pollId).toBeDefined();
    expect(result.pollId).toMatch(/^poll-\d+-[a-z0-9]+$/);
    expect(result.message).toContain('投票创建成功');
    expect(result.message).toContain('你更喜欢哪个编程语言？');
  });

  it('should persist poll state to file', async () => {
    const result = await create_poll({
      question: '测试问题？',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);

    // Verify file was created
    const surveyDir = join(TEST_DIR, 'workspace/surveys');
    expect(existsSync(surveyDir)).toBe(true);

    const pollId = result.pollId!;
    const filePath = join(surveyDir, `${pollId}.json`);
    expect(existsSync(filePath)).toBe(true);

    const saved = JSON.parse(readFileSync(filePath, 'utf-8')) as PollEntry;
    expect(saved.id).toBe(pollId);
    expect(saved.question).toBe('测试问题？');
    expect(saved.options).toHaveLength(2);
    expect(saved.chatId).toBe('oc_test');
    expect(saved.status).toBe('open');
    expect(saved.votes).toEqual({});
  });

  it('should reject empty question', async () => {
    const result = await create_poll({
      question: '',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('question 参数不能为空');
  });

  it('should reject question that is too long', async () => {
    const result = await create_poll({
      question: 'x'.repeat(501),
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('过长');
  });

  it('should reject fewer than 2 options', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [{ text: 'A', value: 'a' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('至少 2 个选项');
  });

  it('should reject more than 10 options', async () => {
    const options = Array.from({ length: 11 }, (_, i) => ({
      text: `Option ${i}`, value: `opt${i}`,
    }));

    const result = await create_poll({
      question: '测试？',
      options,
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('最多');
  });

  it('should reject duplicate option values', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [
        { text: '选项A', value: 'same' },
        { text: '选项B', value: 'same' },
      ],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('重复');
  });

  it('should reject empty chatId', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: '',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('chatId');
  });

  it('should accept optional parameters', async () => {
    const result = await create_poll({
      question: '满意度调查',
      options: [
        { text: '👍 满意', value: 'satisfied' },
        { text: '👎 不满意', value: 'unsatisfied' },
      ],
      chatId: 'oc_test',
      title: '用户满意度调查',
      context: '请对本月服务进行评价',
      anonymous: true,
      deadline: '2027-12-31T23:59:59Z',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('匿名投票');
    expect(result.message).toContain('2027-12-31');
  });

  it('should reject invalid deadline', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
      deadline: 'not-a-date',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('deadline 格式无效');
  });

  it('should reject empty option text', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [
        { text: '', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不能为空');
  });

  it('should reject empty option value', async () => {
    const result = await create_poll({
      question: '测试？',
      options: [
        { text: 'A', value: '' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不能为空');
  });
});

describe('record_poll_vote', () => {
  it('should record a vote', async () => {
    // Create poll first
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // Record vote
    const result = record_poll_vote({
      pollId,
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('投票已记录');
    expect(result.message).toContain('选项A');
  });

  it('should allow changing a vote', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // First vote
    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_001' });

    // Change vote
    const result = record_poll_vote({
      pollId,
      optionValue: 'b',
      userId: 'user_001',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('投票已更新');

    // Verify the file only has one vote from this user
    const surveyDir = join(TEST_DIR, 'workspace/surveys');
    const poll = JSON.parse(readFileSync(join(surveyDir, `${pollId}.json`), 'utf-8')) as PollEntry;
    expect(poll.votes['user_001']).toBe('b');
    expect(Object.keys(poll.votes)).toHaveLength(1);
  });

  it('should reject invalid poll ID', () => {
    const result = record_poll_vote({
      pollId: '',
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('pollId is required');
  });

  it('should reject non-existent poll', () => {
    const result = record_poll_vote({
      pollId: 'non-existent',
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  it('should reject invalid option value', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });

    const result = record_poll_vote({
      pollId: createResult.pollId!,
      optionValue: 'invalid',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('无效的选项');
  });

  it('should reject vote on closed poll', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // Close the poll
    close_poll({ pollId });

    // Try to vote
    const result = record_poll_vote({
      pollId,
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('已关闭');
  });

  it('should reject empty userId', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });

    const result = record_poll_vote({
      pollId: createResult.pollId!,
      optionValue: 'a',
      userId: '',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('userId');
  });

  it('should handle multiple users voting', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_001' });
    record_poll_vote({ pollId, optionValue: 'b', userId: 'user_002' });
    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_003' });

    const results = get_poll_results({ pollId });
    expect(results.success).toBe(true);
    expect(results.summary!.totalVotes).toBe(3);

    const optionA = results.summary!.results.find(r => r.value === 'a');
    expect(optionA!.count).toBe(2);

    const optionB = results.summary!.results.find(r => r.value === 'b');
    expect(optionB!.count).toBe(1);
  });
});

describe('get_poll_results', () => {
  it('should return results for a valid poll', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: '选项A', value: 'a' },
        { text: '选项B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // Cast some votes
    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_001' });
    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_002' });

    const result = get_poll_results({ pollId });

    expect(result.success).toBe(true);
    expect(result.poll).toBeDefined();
    expect(result.summary).toBeDefined();
    expect(result.summary!.totalVotes).toBe(2);

    const optionA = result.summary!.results.find(r => r.value === 'a');
    expect(optionA!.count).toBe(2);
    expect(optionA!.percentage).toBe('100.0%');

    const optionB = result.summary!.results.find(r => r.value === 'b');
    expect(optionB!.count).toBe(0);
    expect(optionB!.percentage).toBe('0.0%');
  });

  it('should include voter IDs for non-anonymous polls', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
      anonymous: false,
    });
    const pollId = createResult.pollId!;

    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_001' });

    const result = get_poll_results({ pollId });
    expect(result.summary!.voters).toContain('user_001');
  });

  it('should not include voter IDs for anonymous polls', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
      anonymous: true,
    });
    const pollId = createResult.pollId!;

    record_poll_vote({ pollId, optionValue: 'a', userId: 'user_001' });

    const result = get_poll_results({ pollId });
    expect(result.summary!.voters).toBeUndefined();
  });

  it('should reject non-existent poll', () => {
    const result = get_poll_results({ pollId: 'non-existent' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  it('should calculate percentages correctly', async () => {
    const createResult = await create_poll({
      question: '测试',
      options: [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
        { text: 'C', value: 'c' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // 1 for A, 2 for B, 1 for C = 4 total
    record_poll_vote({ pollId, optionValue: 'a', userId: 'u1' });
    record_poll_vote({ pollId, optionValue: 'b', userId: 'u2' });
    record_poll_vote({ pollId, optionValue: 'b', userId: 'u3' });
    record_poll_vote({ pollId, optionValue: 'c', userId: 'u4' });

    const result = get_poll_results({ pollId });
    expect(result.success).toBe(true);

    const findResult = (value: string) => result.summary!.results.find(r => r.value === value);
    expect(findResult('a')!.percentage).toBe('25.0%');
    expect(findResult('b')!.percentage).toBe('50.0%');
    expect(findResult('c')!.percentage).toBe('25.0%');
  });
});

describe('close_poll', () => {
  it('should close an open poll', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    const result = close_poll({ pollId });
    expect(result.success).toBe(true);
    expect(result.message).toContain('已关闭');
  });

  it('should reject closing already closed poll', async () => {
    const createResult = await create_poll({
      question: '测试投票',
      options: [
        { text: 'A', value: 'a' },
        { text: 'B', value: 'b' },
      ],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    close_poll({ pollId });
    const result = close_poll({ pollId });
    expect(result.success).toBe(false);
    expect(result.message).toContain('已经关闭');
  });

  it('should reject non-existent poll', () => {
    const result = close_poll({ pollId: 'non-existent' });
    expect(result.success).toBe(false);
  });
});

describe('list_polls', () => {
  it('should return empty list when no polls exist', () => {
    const result = list_polls();
    expect(result.success).toBe(true);
    expect(result.message).toContain('暂无投票');
  });

  it('should list created polls', async () => {
    await create_poll({
      question: '投票1',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
    });
    await create_poll({
      question: '投票2',
      options: [{ text: 'X', value: 'x' }, { text: 'Y', value: 'y' }],
      chatId: 'oc_test',
    });

    const result = list_polls();
    expect(result.success).toBe(true);
    expect(result.message).toContain('共 2 个投票');
    expect(result.message).toContain('投票1');
    expect(result.message).toContain('投票2');
  });

  it('should filter by status', async () => {
    const createResult = await create_poll({
      question: '投票1',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
    });

    await create_poll({
      question: '投票2',
      options: [{ text: 'X', value: 'x' }, { text: 'Y', value: 'y' }],
      chatId: 'oc_test',
    });

    // Close one poll
    close_poll({ pollId: createResult.pollId! });

    const openResult = list_polls({ status: 'open' });
    expect(openResult.message).toContain('共 1 个投票');
    expect(openResult.message).toContain('投票2');

    const closedResult = list_polls({ status: 'closed' });
    expect(closedResult.message).toContain('共 1 个投票');
    expect(closedResult.message).toContain('投票1');
  });
});

describe('edge cases', () => {
  it('should handle poll file corruption gracefully', async () => {
    const createResult = await create_poll({
      question: '测试',
      options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
      chatId: 'oc_test',
    });
    const pollId = createResult.pollId!;

    // Corrupt the file
    const surveyDir = join(TEST_DIR, 'workspace/surveys');
    writeFileSync(join(surveyDir, `${pollId}.json`), 'not valid json{{{');

    const result = record_poll_vote({
      pollId,
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  it('should handle poll with special characters in question', async () => {
    const result = await create_poll({
      question: '你如何评价"AI+教育"？请打分 ⭐',
      options: [
        { text: '⭐⭐⭐⭐⭐ 非常好', value: '5' },
        { text: '⭐⭐⭐⭐ 好', value: '4' },
        { text: '⭐⭐⭐ 一般', value: '3' },
      ],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);
  });

  it('should validate pollId format in record_vote', () => {
    const result = record_poll_vote({
      pollId: '../../../etc/passwd',
      optionValue: 'a',
      userId: 'user_001',
    });

    expect(result.success).toBe(false);
  });
});

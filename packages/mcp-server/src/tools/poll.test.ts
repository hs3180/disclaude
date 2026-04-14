/**
 * Tests for poll tool implementation (packages/mcp-server/src/tools/poll.ts)
 *
 * Issue #2191: Poll/Survey feature (Phase 1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
  Config: {
    getWorkspaceDir: () => mockWorkspaceDir,
  },
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn().mockResolvedValue(true),
  getIpcErrorMessage: vi.fn((_type?: string, originalError?: string) => {
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn().mockReturnValue(null),
}));

vi.mock('./credentials.js', () => ({
  getWorkspaceDir: () => mockWorkspaceDir,
}));

vi.mock('./interactive-message.js', () => ({
  send_interactive: vi.fn(),
  send_interactive_message: vi.fn(),
}));

// Must import AFTER mocks
import { create_poll, record_poll_vote, get_poll_results } from './poll.js';
import { send_interactive } from './interactive-message.js';

let mockWorkspaceDir: string;

describe('poll tools', () => {
  beforeEach(() => {
    mockWorkspaceDir = mkdtempSync(join(tmpdir(), 'poll-test-'));
    vi.clearAllMocks();
    // Mock send_interactive to succeed
    vi.mocked(send_interactive).mockResolvedValue({
      success: true,
      message: '✅ Interactive message sent with 3 action(s)',
    });
  });

  afterEach(() => {
    if (existsSync(mockWorkspaceDir)) {
      rmSync(mockWorkspaceDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // create_poll
  // =========================================================================

  describe('create_poll', () => {
    describe('parameter validation - question', () => {
      it('should return error when question is empty', async () => {
        const result = await create_poll({
          question: '',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('question');
      });

      it('should return error when question is whitespace only', async () => {
        const result = await create_poll({
          question: '   ',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('question');
      });
    });

    describe('parameter validation - options', () => {
      it('should return error when options is empty array', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('options');
      });

      it('should return error when options exceeds 10 items', async () => {
        const options = Array.from({ length: 11 }, (_, i) => ({
          text: `Option ${i}`, value: `opt_${i}`,
        }));
        const result = await create_poll({
          question: 'Q?',
          options,
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('10');
      });

      it('should return error when option text is empty', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: '', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('options[0].text');
      });

      it('should return error when option value is empty', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: '' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('options[0].value');
      });

      it('should return error when option values are duplicated', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'same' }, { text: 'B', value: 'same' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('duplicate');
      });
    });

    describe('parameter validation - chatId', () => {
      it('should return error when chatId is empty', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: '',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('chatId');
      });
    });

    describe('parameter validation - deadline', () => {
      it('should return error when deadline is invalid', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
          deadline: 'not-a-date',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('deadline');
      });

      it('should accept valid ISO deadline', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
          deadline: '2099-12-31T23:59:59.000Z',
        });
        expect(result.success).toBe(true);
      });
    });

    describe('successful creation', () => {
      it('should create poll and return pollId', async () => {
        const result = await create_poll({
          question: 'Which restaurant?',
          options: [
            { text: '🍜 Chinese', value: 'chinese' },
            { text: '🍕 Pizza', value: 'pizza' },
          ],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(true);
        expect(result.pollId).toMatch(/^poll_/);
        expect(result.message).toContain('2 个选项');
      });

      it('should save poll file to disk', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }, { text: 'B', value: 'b' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(true);
        const pollId = result.pollId!;

        const pollFilePath = join(mockWorkspaceDir, 'polls', `${pollId}.json`);
        expect(existsSync(pollFilePath)).toBe(true);

        const pollData = JSON.parse(readFileSync(pollFilePath, 'utf-8'));
        expect(pollData.id).toBe(pollId);
        expect(pollData.question).toBe('Q?');
        expect(pollData.options).toHaveLength(2);
        expect(pollData.votes).toEqual({ a: 0, b: 0 });
        expect(pollData.totalVotes).toBe(0);
      });

      it('should call send_interactive with correct parameters', async () => {
        await create_poll({
          question: 'Which option?',
          options: [
            { text: 'Option A', value: 'opt_a' },
            { text: 'Option B', value: 'opt_b' },
          ],
          chatId: 'oc_test',
          title: 'My Poll',
        });

        expect(send_interactive).toHaveBeenCalled();
        const [[call]] = vi.mocked(send_interactive).mock.calls;
        expect(call.question).toContain('Which option?');
        expect(call.options).toHaveLength(2);
        expect(call.title).toBe('My Poll');
        expect(call.chatId).toBe('oc_test');
        // Verify action prompts are generated
        expect(call.actionPrompts).toBeDefined();
        expect(call.actionPrompts!['opt_a']).toContain('record_poll_vote');
        expect(call.actionPrompts!['opt_b']).toContain('record_poll_vote');
      });

      it('should use default title when not provided', async () => {
        await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });

        const [[call]] = vi.mocked(send_interactive).mock.calls;
        expect(call.title).toBe('📊 投票');
      });

      it('should make first option primary style', async () => {
        await create_poll({
          question: 'Q?',
          options: [
            { text: 'First', value: 'first' },
            { text: 'Second', value: 'second' },
          ],
          chatId: 'oc_test',
        });

        const [[call]] = vi.mocked(send_interactive).mock.calls;
        expect(call.options[0].type).toBe('primary');
        expect(call.options[1].type).toBe('default');
      });
    });

    describe('send failure', () => {
      it('should return error when send_interactive fails', async () => {
        vi.mocked(send_interactive).mockResolvedValue({
          success: false,
          error: 'IPC failed',
          message: '❌ IPC 服务不可用',
        });

        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);
        expect(result.message).toContain('发送失败');
      });

      it('should clean up poll file when send fails', async () => {
        vi.mocked(send_interactive).mockResolvedValue({
          success: false,
          error: 'IPC failed',
          message: '❌ IPC 服务不可用',
        });

        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
        });
        expect(result.success).toBe(false);

        // Verify no poll files were left
        const pollsDir = join(mockWorkspaceDir, 'polls');
        if (existsSync(pollsDir)) {
          const files = readdirSync(pollsDir);
          expect(files).toHaveLength(0);
        }
      });
    });
  });

  // =========================================================================
  // record_poll_vote
  // =========================================================================

  describe('record_poll_vote', () => {
    async function setupPoll(): Promise<string> {
      const result = await create_poll({
        question: 'Which restaurant?',
        options: [
          { text: '🍜 Chinese', value: 'chinese' },
          { text: '🍕 Pizza', value: 'pizza' },
          { text: '🍱 Japanese', value: 'japanese' },
        ],
        chatId: 'oc_test',
      });
      return result.pollId!;
    }

    describe('parameter validation', () => {
      it('should return error when pollId is empty', async () => {
        const result = await record_poll_vote({ pollId: '', optionValue: 'a' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('pollId');
      });

      it('should return error when optionValue is empty', async () => {
        const result = await record_poll_vote({ pollId: 'poll_123', optionValue: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('optionValue');
      });

      it('should return error when poll does not exist', async () => {
        const result = await record_poll_vote({ pollId: 'nonexistent', optionValue: 'a' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });

      it('should return error when option does not exist in poll', async () => {
        const pollId = await setupPoll();
        const result = await record_poll_vote({ pollId, optionValue: 'invalid' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid option');
      });
    });

    describe('successful voting', () => {
      it('should record a vote and return confirmation', async () => {
        const pollId = await setupPoll();
        const result = await record_poll_vote({ pollId, optionValue: 'chinese' });
        expect(result.success).toBe(true);
        expect(result.message).toContain('🍜 Chinese');
        expect(result.message).toContain('1 票');
      });

      it('should persist vote to disk', async () => {
        const pollId = await setupPoll();
        await record_poll_vote({ pollId, optionValue: 'chinese' });
        await record_poll_vote({ pollId, optionValue: 'pizza' });
        await record_poll_vote({ pollId, optionValue: 'chinese' });

        const pollFilePath = join(mockWorkspaceDir, 'polls', `${pollId}.json`);
        const pollData = JSON.parse(readFileSync(pollFilePath, 'utf-8'));
        expect(pollData.votes.chinese).toBe(2);
        expect(pollData.votes.pizza).toBe(1);
        expect(pollData.votes.japanese).toBe(0);
        expect(pollData.totalVotes).toBe(3);
      });

      it('should return updated vote count in message', async () => {
        const pollId = await setupPoll();
        await record_poll_vote({ pollId, optionValue: 'chinese' });
        const result = await record_poll_vote({ pollId, optionValue: 'chinese' });
        expect(result.message).toContain('2 票');
        expect(result.message).toContain('总计 2 票');
      });
    });

    describe('deadline enforcement', () => {
      it('should reject votes after deadline', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
          deadline: '2020-01-01T00:00:00.000Z', // Already past
        });
        expect(result.success).toBe(true);

        const voteResult = await record_poll_vote({
          pollId: result.pollId!,
          optionValue: 'a',
        });
        expect(voteResult.success).toBe(false);
        expect(voteResult.message).toContain('已截止');
      });

      it('should accept votes before deadline', async () => {
        const result = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
          deadline: '2099-12-31T23:59:59.000Z', // Far future
        });
        expect(result.success).toBe(true);

        const voteResult = await record_poll_vote({
          pollId: result.pollId!,
          optionValue: 'a',
        });
        expect(voteResult.success).toBe(true);
      });
    });
  });

  // =========================================================================
  // get_poll_results
  // =========================================================================

  describe('get_poll_results', () => {
    describe('parameter validation', () => {
      it('should return error when pollId is empty', async () => {
        const result = await get_poll_results({ pollId: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('pollId');
      });

      it('should return error when poll does not exist', async () => {
        const result = await get_poll_results({ pollId: 'nonexistent' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
      });
    });

    describe('results formatting', () => {
      it('should show zero votes for new poll', async () => {
        const createResult = await create_poll({
          question: 'Which restaurant?',
          options: [
            { text: '🍜 Chinese', value: 'chinese' },
            { text: '🍕 Pizza', value: 'pizza' },
          ],
          chatId: 'oc_test',
        });
        const result = await get_poll_results({ pollId: createResult.pollId! });
        expect(result.success).toBe(true);
        expect(result.message).toContain('Which restaurant?');
        expect(result.message).toContain('总票数: 0');
      });

      it('should show vote counts and percentages', async () => {
        const createResult = await create_poll({
          question: 'Favorite color?',
          options: [
            { text: '🔴 Red', value: 'red' },
            { text: '🔵 Blue', value: 'blue' },
          ],
          chatId: 'oc_test',
        });
        const pollId = createResult.pollId!;

        await record_poll_vote({ pollId, optionValue: 'red' });
        await record_poll_vote({ pollId, optionValue: 'red' });
        await record_poll_vote({ pollId, optionValue: 'blue' });

        const result = await get_poll_results({ pollId });
        expect(result.success).toBe(true);
        expect(result.message).toContain('总票数: 3');
        expect(result.message).toContain('67%'); // 2/3 ≈ 67%
        expect(result.message).toContain('33%'); // 1/3 ≈ 33%
      });

      it('should show deadline if set', async () => {
        const createResult = await create_poll({
          question: 'Q?',
          options: [{ text: 'A', value: 'a' }],
          chatId: 'oc_test',
          deadline: '2099-12-31T23:59:59.000Z',
        });

        const result = await get_poll_results({ pollId: createResult.pollId! });
        expect(result.success).toBe(true);
        expect(result.message).toContain('截止时间');
        expect(result.message).toContain('2099');
      });
    });
  });
});

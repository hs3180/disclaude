/**
 * Tests for create_poll, record_poll_vote, and poll_results MCP tools.
 *
 * @module mcp-server/tools/create-poll.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create_poll, record_poll_vote, poll_results } from './create-poll.js';

// Mock IPC utilities
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn().mockResolvedValue(true),
  getIpcErrorMessage: vi.fn((type: string, error: string) => error || type),
}));

// Mock callback manager
vi.mock('./callback-manager.js', () => ({
  getMessageSentCallback: vi.fn().mockReturnValue(null),
}));

// Mock @disclaude/core IPC client
const mockSendInteractive = vi.fn().mockResolvedValue({ success: true });
vi.mock('@disclaude/core', async () => {
  const actual = await vi.importActual('@disclaude/core');
  return {
    ...actual,
    getIpcClient: () => ({
      sendInteractive: mockSendInteractive,
    }),
  };
});

describe('create_poll', () => {
  it('should reject empty question', async () => {
    const result = await create_poll({
      question: '',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('不能为空');
  });

  it('should reject less than 2 options', async () => {
    const result = await create_poll({
      question: 'Test?',
      options: [{ text: 'Only one' }],
      chatId: 'oc_test',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing chatId', async () => {
    const result = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should create a poll and send interactive card', async () => {
    const result = await create_poll({
      question: 'Best language?',
      options: [{ text: 'TypeScript' }, { text: 'Python' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);
    expect(result.pollId).toBeDefined();
    expect(result.message).toContain('投票已创建');

    // Verify sendInteractive was called with correct options
    expect(mockSendInteractive).toHaveBeenCalledWith(
      'oc_test',
      expect.objectContaining({
        question: expect.stringContaining('Best language?'),
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'option_0', text: 'TypeScript' }),
          expect.objectContaining({ value: 'option_1', text: 'Python' }),
          expect.objectContaining({ value: 'poll_view_results', text: expect.stringContaining('查看结果') }),
        ]),
      }),
    );
  });

  it('should include actionPrompts with poll ID', async () => {
    const result = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(true);
    const lastCall = mockSendInteractive.mock.calls[mockSendInteractive.mock.calls.length - 1];
    const [, callArgs] = lastCall;
    expect(callArgs.actionPrompts['option_0']).toContain(result.pollId);
    expect(callArgs.actionPrompts['option_0']).toContain('record_poll_vote');
    expect(callArgs.actionPrompts['poll_view_results']).toContain('poll_results');
  });

  it('should include description in question when provided', async () => {
    await create_poll({
      question: 'Best language?',
      options: [{ text: 'TS' }, { text: 'Py' }],
      chatId: 'oc_test',
      description: 'Team survey',
    });

    const lastCall = mockSendInteractive.mock.calls[mockSendInteractive.mock.calls.length - 1];
    const [, callArgs] = lastCall;
    expect(callArgs.question).toContain('Team survey');
    expect(callArgs.question).toContain('Best language?');
  });

  it('should handle IPC send failure', async () => {
    mockSendInteractive.mockRejectedValueOnce(new Error('IPC error'));

    const result = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('失败');
  });

  it('should handle IPC unavailable', async () => {
    const { isIpcAvailable } = await import('./ipc-utils.js');
    vi.mocked(isIpcAvailable).mockResolvedValueOnce(false);

    const result = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });
});

describe('record_poll_vote', () => {
  beforeEach(() => {
    // Create a poll first for voting tests
    mockSendInteractive.mockResolvedValue({ success: true });
  });

  it('should reject missing parameters', async () => {
    const result = await record_poll_vote({
      pollId: '',
      optionId: '',
      voterId: '',
    });
    expect(result.success).toBe(false);
  });

  it('should reject vote for non-existent poll', async () => {
    const result = await record_poll_vote({
      pollId: 'poll_nonexistent',
      optionId: 'option_0',
      voterId: 'user_1',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('should record a vote successfully', async () => {
    // First create a poll
    const pollResult = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
      anonymous: false,
    });

    // Then record a vote
    const voteResult = await record_poll_vote({
      pollId: pollResult.pollId!,
      optionId: 'option_0',
      voterId: 'user_1',
    });

    expect(voteResult.success).toBe(true);
    expect(voteResult.message).toContain('A');
    expect(voteResult.message).toContain('1 票');
  });

  it('should update existing vote', async () => {
    // Create a poll
    const pollResult = await create_poll({
      question: 'Test?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
      anonymous: false,
    });

    // Vote for A
    await record_poll_vote({
      pollId: pollResult.pollId!,
      optionId: 'option_0',
      voterId: 'user_1',
    });

    // Change vote to B
    const voteResult = await record_poll_vote({
      pollId: pollResult.pollId!,
      optionId: 'option_1',
      voterId: 'user_1',
    });

    expect(voteResult.success).toBe(true);
    expect(voteResult.message).toContain('B');
    // Should still be 1 vote total
    expect(voteResult.message).toContain('1 票');
  });
});

describe('poll_results', () => {
  it('should reject missing pollId', async () => {
    const result = await poll_results({ pollId: '' });
    expect(result.success).toBe(false);
  });

  it('should return error for non-existent poll', async () => {
    const result = await poll_results({ pollId: 'poll_nonexistent' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('不存在');
  });

  it('should return formatted results', async () => {
    // Create a poll
    mockSendInteractive.mockResolvedValue({ success: true });
    const pollResult = await create_poll({
      question: 'Best?',
      options: [{ text: 'A' }, { text: 'B' }],
      chatId: 'oc_test',
      anonymous: false,
    });

    // Record some votes
    await record_poll_vote({ pollId: pollResult.pollId!, optionId: 'option_0', voterId: 'u1' });
    await record_poll_vote({ pollId: pollResult.pollId!, optionId: 'option_0', voterId: 'u2' });
    await record_poll_vote({ pollId: pollResult.pollId!, optionId: 'option_1', voterId: 'u3' });

    // Get results
    const result = await poll_results({ pollId: pollResult.pollId! });

    expect(result.success).toBe(true);
    expect(result.results).toContain('Best?');
    expect(result.results).toContain('3');
    expect(result.results).toContain('A');
  });
});

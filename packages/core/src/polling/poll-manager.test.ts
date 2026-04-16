/**
 * Tests for PollManager.
 *
 * @module core/polling/poll-manager.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PollManager } from './poll-manager.js';
import type { PollValidationError } from './types.js';

describe('PollManager', () => {
  let tmpDir: string;
  let manager: PollManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poll-test-'));
    manager = new PollManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('validateCreatePoll', () => {
    it('should reject empty question', () => {
      const result = manager.validateCreatePoll({
        question: '',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject non-string question', () => {
      const result = manager.validateCreatePoll({
        question: 123 as unknown as string,
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject question exceeding max length', () => {
      const result = manager.validateCreatePoll({
        question: 'x'.repeat(501),
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
      expect((result as PollValidationError).error).toContain('500');
    });

    it('should reject less than 2 options', () => {
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'Only one' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
      expect((result as PollValidationError).error).toContain('2 options');
    });

    it('should reject more than 20 options', () => {
      const options = Array.from({ length: 21 }, (_, i) => ({ text: `Option ${i}` }));
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options,
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject empty option text', () => {
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'A' }, { text: '' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject duplicate options', () => {
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'Same' }, { text: 'same' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(false);
      expect((result as PollValidationError).error).toContain('Duplicate');
    });

    it('should reject missing chatId', () => {
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: '',
      });
      expect(result.valid).toBe(false);
    });

    it('should reject past expiresAt', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
        expiresAt: past,
      });
      expect(result.valid).toBe(false);
      expect((result as PollValidationError).error).toContain('future');
    });

    it('should reject invalid expiresAt format', () => {
      const result = manager.validateCreatePoll({
        question: 'Test?',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
        expiresAt: 'not-a-date',
      });
      expect(result.valid).toBe(false);
    });

    it('should accept valid options', () => {
      const result = manager.validateCreatePoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });
      expect(result.valid).toBe(true);
    });

    it('should accept valid options with future expiresAt', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const result = manager.validateCreatePoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        expiresAt: future,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('createPoll', () => {
    it('should create a poll with correct defaults', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      expect(poll.id).toMatch(/^poll_[a-z0-9]+_[a-f0-9]+$/);
      expect(poll.question).toBe('Best language?');
      expect(poll.options).toHaveLength(2);
      expect(poll.options[0].id).toBe('option_0');
      expect(poll.options[0].text).toBe('TypeScript');
      expect(poll.options[1].id).toBe('option_1');
      expect(poll.options[1].text).toBe('Python');
      expect(poll.votes).toEqual([]);
      expect(poll.chatId).toBe('oc_test');
      expect(poll.anonymous).toBe(true);
      expect(poll.closed).toBe(false);
      expect(poll.createdAt).toBeDefined();
    });

    it('should persist poll to file', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      const filePath = path.join(tmpDir, `${poll.id}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      const loaded = JSON.parse(data);
      expect(loaded.id).toBe(poll.id);
      expect(loaded.question).toBe(poll.question);
    });

    it('should set anonymous to false when specified', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        anonymous: false,
      });
      expect(poll.anonymous).toBe(false);
    });

    it('should trim question and option text', async () => {
      const poll = await manager.createPoll({
        question: '  Best language?  ',
        options: [{ text: '  TypeScript  ' }, { text: '  Python  ' }],
        chatId: 'oc_test',
      });
      expect(poll.question).toBe('Best language?');
      expect(poll.options[0].text).toBe('TypeScript');
      expect(poll.options[1].text).toBe('Python');
    });

    it('should throw on invalid options', async () => {
      await expect(manager.createPoll({
        question: '',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      })).rejects.toThrow('non-empty string');
    });
  });

  describe('getPoll', () => {
    it('should return created poll', async () => {
      const created = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });
      const fetched = await manager.getPoll(created.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.question).toBe(created.question);
    });

    it('should return undefined for non-existent poll', async () => {
      const result = await manager.getPoll('poll_nonexistent');
      expect(result).toBeUndefined();
    });

    it('should use cache for repeated reads', async () => {
      const created = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      // First read loads from file
      manager.clearCache();
      const first = await manager.getPoll(created.id);
      // Second read should use cache
      const second = await manager.getPoll(created.id);
      expect(first).toEqual(second);
    });
  });

  describe('recordVote', () => {
    it('should record a vote', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        anonymous: false,
      });

      const updated = await manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      });

      expect(updated.votes).toHaveLength(1);
      expect(updated.votes[0].optionId).toBe('option_0');
      expect(updated.votes[0].voterId).toBe('user_1');
      expect(updated.votes[0].votedAt).toBeDefined();
    });

    it('should anonymize voter ID when anonymous', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        anonymous: true,
      });

      const updated = await manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      });

      expect(updated.votes[0].voterId).not.toBe('user_1');
      expect(updated.votes[0].voterId).toHaveLength(12);
    });

    it('should update existing vote for same voter', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        anonymous: false,
      });

      await manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      });
      const updated = await manager.recordVote({
        pollId: poll.id,
        optionId: 'option_1',
        voterId: 'user_1',
      });

      expect(updated.votes).toHaveLength(1);
      expect(updated.votes[0].optionId).toBe('option_1');
    });

    it('should reject vote for non-existent poll', async () => {
      await expect(manager.recordVote({
        pollId: 'poll_nonexistent',
        optionId: 'option_0',
        voterId: 'user_1',
      })).rejects.toThrow('not found');
    });

    it('should reject vote for invalid option', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      await expect(manager.recordVote({
        pollId: poll.id,
        optionId: 'option_invalid',
        voterId: 'user_1',
      })).rejects.toThrow('Invalid option');
    });

    it('should reject vote for closed poll', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      await manager.closePoll(poll.id);

      await expect(manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      })).rejects.toThrow('closed');
    });

    it('should reject vote for expired poll', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      });

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 1100));

      await expect(manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      })).rejects.toThrow('expired');
    });

    it('should persist vote to file', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
        anonymous: false,
      });

      await manager.recordVote({
        pollId: poll.id,
        optionId: 'option_0',
        voterId: 'user_1',
      });

      manager.clearCache();
      const reloaded = await manager.getPoll(poll.id);
      expect(reloaded!.votes).toHaveLength(1);
      expect(reloaded!.votes[0].optionId).toBe('option_0');
    });
  });

  describe('getPollResults', () => {
    it('should return aggregated results', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }, { text: 'Go' }],
        chatId: 'oc_test',
        anonymous: false,
      });

      await manager.recordVote({ pollId: poll.id, optionId: 'option_0', voterId: 'user_1' });
      await manager.recordVote({ pollId: poll.id, optionId: 'option_0', voterId: 'user_2' });
      await manager.recordVote({ pollId: poll.id, optionId: 'option_1', voterId: 'user_3' });

      const results = await manager.getPollResults(poll.id);
      expect(results).toBeDefined();
      expect(results!.pollId).toBe(poll.id);
      expect(results!.question).toBe('Best language?');
      expect(results!.totalVotes).toBe(3);
      expect(results!.results).toHaveLength(3);

      // TypeScript should be first (most votes)
      expect(results!.results[0].id).toBe('option_0');
      expect(results!.results[0].voteCount).toBe(2);
      expect(results!.results[0].percentage).toBeCloseTo(66.7, 0);

      // Python second
      expect(results!.results[1].id).toBe('option_1');
      expect(results!.results[1].voteCount).toBe(1);
      expect(results!.results[1].percentage).toBeCloseTo(33.3, 0);

      // Go last (0 votes)
      expect(results!.results[2].id).toBe('option_2');
      expect(results!.results[2].voteCount).toBe(0);
      expect(results!.results[2].percentage).toBe(0);
    });

    it('should return undefined for non-existent poll', async () => {
      const results = await manager.getPollResults('poll_nonexistent');
      expect(results).toBeUndefined();
    });

    it('should handle zero votes', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      const results = await manager.getPollResults(poll.id);
      expect(results!.totalVotes).toBe(0);
      for (const r of results!.results) {
        expect(r.voteCount).toBe(0);
        expect(r.percentage).toBe(0);
      }
    });
  });

  describe('closePoll', () => {
    it('should close a poll', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      const closed = await manager.closePoll(poll.id);
      expect(closed!.closed).toBe(true);
    });

    it('should return undefined for non-existent poll', async () => {
      const result = await manager.closePoll('poll_nonexistent');
      expect(result).toBeUndefined();
    });
  });

  describe('deletePoll', () => {
    it('should delete a poll', async () => {
      const poll = await manager.createPoll({
        question: 'Best language?',
        options: [{ text: 'TypeScript' }, { text: 'Python' }],
        chatId: 'oc_test',
      });

      const deleted = await manager.deletePoll(poll.id);
      expect(deleted).toBe(true);

      const fetched = await manager.getPoll(poll.id);
      expect(fetched).toBeUndefined();
    });

    it('should return false for non-existent poll', async () => {
      const result = await manager.deletePoll('poll_nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('listPolls', () => {
    it('should list all polls', async () => {
      await manager.createPoll({
        question: 'Poll 1',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test1',
      });
      await manager.createPoll({
        question: 'Poll 2',
        options: [{ text: 'C' }, { text: 'D' }],
        chatId: 'oc_test2',
      });

      const polls = await manager.listPolls();
      expect(polls).toHaveLength(2);
    });

    it('should filter by chatId', async () => {
      await manager.createPoll({
        question: 'Poll 1',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test1',
      });
      await manager.createPoll({
        question: 'Poll 2',
        options: [{ text: 'C' }, { text: 'D' }],
        chatId: 'oc_test2',
      });

      const polls = await manager.listPolls('oc_test1');
      expect(polls).toHaveLength(1);
      expect(polls[0].chatId).toBe('oc_test1');
    });

    it('should return empty array for no polls', async () => {
      const polls = await manager.listPolls();
      expect(polls).toEqual([]);
    });

    it('should sort by creation time (newest first)', async () => {
      const poll1 = await manager.createPoll({
        question: 'First',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      });
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10));
      const poll2 = await manager.createPoll({
        question: 'Second',
        options: [{ text: 'C' }, { text: 'D' }],
        chatId: 'oc_test',
      });

      const polls = await manager.listPolls();
      expect(polls[0].id).toBe(poll2.id);
      expect(polls[1].id).toBe(poll1.id);
    });
  });

  describe('formatResultsText', () => {
    it('should format results as readable text', () => {
      const results = {
        pollId: 'poll_test',
        question: 'Best language?',
        results: [
          { id: 'option_0', text: 'TypeScript', voteCount: 5, percentage: 50 },
          { id: 'option_1', text: 'Python', voteCount: 3, percentage: 30 },
          { id: 'option_2', text: 'Go', voteCount: 2, percentage: 20 },
        ],
        totalVotes: 10,
        closed: false,
        expired: false,
      };

      const text = manager.formatResultsText(results);
      expect(text).toContain('📊');
      expect(text).toContain('Best language?');
      expect(text).toContain('10');
      expect(text).toContain('TypeScript');
      expect(text).toContain('50%');
    });

    it('should show locked icon for closed polls', () => {
      const results = {
        pollId: 'poll_test',
        question: 'Test?',
        results: [],
        totalVotes: 0,
        closed: true,
        expired: false,
      };

      const text = manager.formatResultsText(results);
      expect(text).toContain('🔒');
      expect(text).toContain('已关闭');
    });

    it('should show clock icon for expired polls', () => {
      const results = {
        pollId: 'poll_test',
        question: 'Test?',
        results: [],
        totalVotes: 0,
        closed: false,
        expired: true,
      };

      const text = manager.formatResultsText(results);
      expect(text).toContain('⏰');
      expect(text).toContain('已过期');
    });
  });

  describe('generateActionPrompts', () => {
    it('should generate prompts for each option', () => {
      const poll = {
        id: 'poll_test',
        question: 'Best language?',
        options: [
          { id: 'option_0', text: 'TypeScript' },
          { id: 'option_1', text: 'Python' },
        ],
        votes: [],
        chatId: 'oc_test',
        createdAt: new Date().toISOString(),
        anonymous: true,
        closed: false,
      };

      const prompts = manager.generateActionPrompts(poll);
      expect(Object.keys(prompts)).toContain('option_0');
      expect(Object.keys(prompts)).toContain('option_1');
      expect(Object.keys(prompts)).toContain('poll_view_results');

      expect(prompts['option_0']).toContain('TypeScript');
      expect(prompts['option_0']).toContain('poll_test');
      expect(prompts['option_0']).toContain('record_poll_vote');
    });

    it('should include view results prompt', () => {
      const poll = {
        id: 'poll_test',
        question: 'Best?',
        options: [{ id: 'option_0', text: 'A' }, { id: 'option_1', text: 'B' }],
        votes: [],
        chatId: 'oc_test',
        createdAt: new Date().toISOString(),
        anonymous: false,
        closed: false,
      };

      const prompts = manager.generateActionPrompts(poll);
      expect(prompts['poll_view_results']).toContain('poll_results');
      expect(prompts['poll_view_results']).toContain('poll_test');
    });
  });

  describe('pollExists', () => {
    it('should return true for existing poll', async () => {
      const poll = await manager.createPoll({
        question: 'Test?',
        options: [{ text: 'A' }, { text: 'B' }],
        chatId: 'oc_test',
      });
      expect(await manager.pollExists(poll.id)).toBe(true);
    });

    it('should return false for non-existent poll', async () => {
      expect(await manager.pollExists('poll_nonexistent')).toBe(false);
    });
  });
});

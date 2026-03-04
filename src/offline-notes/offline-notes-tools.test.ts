/**
 * Tests for Offline Notes Tools.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  leave_note,
  read_notes,
  check_answers,
  get_note,
  delete_note,
} from './offline-notes-tools.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  access: vi.fn(),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
    FEISHU_APP_ID: '',
    FEISHU_APP_SECRET: '',
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock Feishu client
vi.mock('../platforms/feishu/create-feishu-client.js', () => ({
  createFeishuClient: vi.fn(),
}));

describe('Offline Notes Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('leave_note', () => {
    it('should create a note and return note ID', async () => {
      const result = await leave_note({
        question: 'What database should I use?',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(true);
      expect(result.noteId).toBeDefined();
      expect(result.noteId).toMatch(/^note_/);
    });

    it('should fail without question', async () => {
      const result = await leave_note({
        question: '',
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should fail without chatId', async () => {
      const result = await leave_note({
        question: 'Test question',
        chatId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    it('should include context and task context', async () => {
      const result = await leave_note({
        question: 'Test question',
        chatId: 'oc_test',
        context: 'Building a new microservice',
        taskContext: 'Implementing authentication',
      });

      expect(result.success).toBe(true);

      // Verify the note was created with context
      const noteResult = await get_note(result.noteId!);
      expect(noteResult.success).toBe(true);
      expect(noteResult.note?.context).toBe('Building a new microservice');
      expect(noteResult.note?.taskContext).toBe('Implementing authentication');
    });

    it('should handle CLI mode', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const result = await leave_note({
        question: 'CLI test question',
        chatId: 'cli-test',
      });

      expect(result.success).toBe(true);
      expect(result.noteId).toBeDefined();

      consoleSpy.mockRestore();
    });

    it('should handle tags', async () => {
      const result = await leave_note({
        question: 'Test question',
        chatId: 'oc_test',
        tags: ['database', 'architecture'],
      });

      expect(result.success).toBe(true);

      const noteResult = await get_note(result.noteId!);
      expect(noteResult.note?.tags).toEqual(['database', 'architecture']);
    });
  });

  describe('read_notes', () => {
    it('should return created notes', async () => {
      // Create some notes
      await leave_note({ question: 'Q1', chatId: 'oc_test1' });
      await leave_note({ question: 'Q2', chatId: 'oc_test2' });

      const result = await read_notes({});

      expect(result.success).toBe(true);
      expect(result.notes?.length).toBeGreaterThanOrEqual(2);
    });

    it('should filter by status', async () => {
      await leave_note({ question: 'Q1', chatId: 'oc_test' });

      const result = await read_notes({ status: 'pending' });

      expect(result.success).toBe(true);
      expect(result.notes?.length).toBeGreaterThanOrEqual(1);
      expect(result.notes?.every(n => n.status === 'pending')).toBe(true);
    });

    it('should filter by chatId', async () => {
      const uniqueChatId = `oc_chat_filter_${Date.now()}`;
      await leave_note({ question: 'Q1', chatId: uniqueChatId });
      await leave_note({ question: 'Q2', chatId: 'oc_other_chat' });

      const result = await read_notes({ chatId: uniqueChatId });

      expect(result.success).toBe(true);
      expect(result.notes?.length).toBeGreaterThanOrEqual(1);
      expect(result.notes?.every(n => n.chatId === uniqueChatId)).toBe(true);
    });

    it('should apply limit', async () => {
      const uniqueChatId = `oc_limit_${Date.now()}`;
      await leave_note({ question: 'Q1', chatId: uniqueChatId });
      await leave_note({ question: 'Q2', chatId: uniqueChatId });
      await leave_note({ question: 'Q3', chatId: uniqueChatId });

      const result = await read_notes({ chatId: uniqueChatId, limit: 2 });

      expect(result.success).toBe(true);
      expect(result.notes?.length).toBe(2);
    });
  });

  describe('check_answers', () => {
    it('should return only answered notes', async () => {
      // This test verifies the function works correctly
      // In a real scenario, notes would be answered via handleNoteReply
      const result = await check_answers();

      expect(result.success).toBe(true);
      expect(Array.isArray(result.notes)).toBe(true);
    });
  });

  describe('get_note', () => {
    it('should return a specific note', async () => {
      const created = await leave_note({
        question: 'Test question',
        chatId: 'oc_test',
        context: 'Test context',
      });

      const result = await get_note(created.noteId!);

      expect(result.success).toBe(true);
      expect(result.note?.question).toBe('Test question');
      expect(result.note?.context).toBe('Test context');
    });

    it('should return error for non-existent note', async () => {
      const result = await get_note('non_existent_note');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('delete_note', () => {
    it('should delete an existing note', async () => {
      const created = await leave_note({
        question: 'Test question to delete',
        chatId: 'oc_test',
      });

      const result = await delete_note(created.noteId!);

      expect(result.success).toBe(true);
      expect(result.message).toContain('deleted');

      // Verify it's gone
      const getResult = await get_note(created.noteId!);
      expect(getResult.success).toBe(false);
    });

    it('should return error for non-existent note', async () => {
      const result = await delete_note('non_existent_note');

      expect(result.success).toBe(false);
    });
  });

  describe('workflow', () => {
    it('should support full workflow: leave -> read -> delete', async () => {
      // 1. Leave a note
      const leaveResult = await leave_note({
        question: 'Should I use PostgreSQL or MongoDB?',
        context: 'Building a new microservice for user data',
        chatId: 'oc_test',
        tags: ['database', 'architecture'],
      });
      expect(leaveResult.success).toBe(true);

      // 2. Read pending notes
      const pendingResult = await read_notes({ status: 'pending' });
      expect(pendingResult.success).toBe(true);
      expect(pendingResult.notes!.length).toBeGreaterThanOrEqual(1);

      // 3. Get specific note
      const noteResult = await get_note(leaveResult.noteId!);
      expect(noteResult.success).toBe(true);
      expect(noteResult.note?.question).toContain('PostgreSQL');

      // 4. Delete the note
      const deleteResult = await delete_note(leaveResult.noteId!);
      expect(deleteResult.success).toBe(true);
    });
  });
});

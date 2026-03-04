/**
 * Tests for Note Manager.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { NoteManager, resetNoteManager } from './note-manager.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  access: vi.fn(),
  stat: vi.fn(),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
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

describe('NoteManager', () => {
  let manager: NoteManager;
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
    resetNoteManager();
    manager = new NoteManager();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('createNote', () => {
    it('should create a new note with generated ID', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const note = await manager.createNote({
        question: 'What database should I use?',
        chatId: 'oc_test',
      });

      expect(note.id).toMatch(/^note_/);
      expect(note.question).toBe('What database should I use?');
      expect(note.chatId).toBe('oc_test');
      expect(note.status).toBe('pending');
      expect(note.createdAt).toBeDefined();
    });

    it('should set expiration time correctly', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const note = await manager.createNote({
        question: 'Test question',
        chatId: 'oc_test',
        expiresAt: new Date(Date.now() + 86400000).toISOString(), // 1 day
      });

      expect(note.expiresAt).toBeDefined();
    });

    it('should include optional fields', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const note = await manager.createNote({
        question: 'Test question',
        chatId: 'oc_test',
        context: 'Building a new service',
        taskContext: 'Implementing auth',
        tags: ['database', 'architecture'],
      });

      expect(note.context).toBe('Building a new service');
      expect(note.taskContext).toBe('Implementing auth');
      expect(note.tags).toEqual(['database', 'architecture']);
    });
  });

  describe('getNote', () => {
    it('should retrieve a note by ID', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const created = await manager.createNote({
        question: 'Test question',
        chatId: 'oc_test',
      });

      const retrieved = await manager.getNote(created.id);
      expect(retrieved).toEqual(created);
    });

    it('should return undefined for non-existent note', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const note = await manager.getNote('non_existent');
      expect(note).toBeUndefined();
    });
  });

  describe('updateNote', () => {
    it('should update note fields', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const created = await manager.createNote({
        question: 'Test question',
        chatId: 'oc_test',
      });

      const updated = await manager.updateNote(created.id, {
        messageId: 'msg_123',
      });

      expect(updated?.messageId).toBe('msg_123');
      expect(updated?.question).toBe('Test question'); // Original field preserved
    });

    it('should return undefined for non-existent note', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const result = await manager.updateNote('non_existent', { messageId: 'msg_123' });
      expect(result).toBeUndefined();
    });
  });

  describe('answerNote', () => {
    it('should mark note as answered', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const created = await manager.createNote({
        question: 'What DB?',
        chatId: 'oc_test',
      });

      const answered = await manager.answerNote(created.id, 'Use PostgreSQL', 'ou_user_123');

      expect(answered?.status).toBe('answered');
      expect(answered?.answer).toBe('Use PostgreSQL');
      expect(answered?.answeredBy).toBe('ou_user_123');
      expect(answered?.answeredAt).toBeDefined();
    });
  });

  describe('queryNotes', () => {
    beforeEach(async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      // Create test notes
      await manager.createNote({ question: 'Q1', chatId: 'oc_chat1', tags: ['db'] });
      await manager.createNote({ question: 'Q2', chatId: 'oc_chat2', tags: ['api'] });
      await manager.createNote({ question: 'Q3', chatId: 'oc_chat1', tags: ['db', 'auth'] });
    });

    it('should filter by chatId', async () => {
      const notes = await manager.queryNotes({ chatId: 'oc_chat1' });
      expect(notes.length).toBe(2);
      expect(notes.every(n => n.chatId === 'oc_chat1')).toBe(true);
    });

    it('should filter by tags', async () => {
      const notes = await manager.queryNotes({ tags: ['db'] });
      expect(notes.length).toBe(2);
    });

    it('should apply limit', async () => {
      const notes = await manager.queryNotes({ limit: 2 });
      expect(notes.length).toBe(2);
    });

    it('should sort by creation date (newest first)', async () => {
      const notes = await manager.queryNotes({});
      expect(notes.length).toBe(3);
      // Newest should be first
      expect(new Date(notes[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(notes[1].createdAt).getTime()
      );
    });
  });

  describe('findByMessageId', () => {
    it('should find note by message ID', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const created = await manager.createNote({
        question: 'Test',
        chatId: 'oc_test',
      });
      await manager.updateNote(created.id, { messageId: 'msg_abc123' });

      const found = await manager.findByMessageId('msg_abc123');
      expect(found?.id).toBe(created.id);
    });

    it('should return undefined if not found', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const found = await manager.findByMessageId('non_existent');
      expect(found).toBeUndefined();
    });
  });

  describe('deleteNote', () => {
    it('should delete an existing note', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      const created = await manager.createNote({
        question: 'Test',
        chatId: 'oc_test',
      });

      const deleted = await manager.deleteNote(created.id);
      expect(deleted).toBe(true);

      const retrieved = await manager.getNote(created.id);
      expect(retrieved).toBeUndefined();
    });

    it('should return false for non-existent note', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const deleted = await manager.deleteNote('non_existent');
      expect(deleted).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockResolvedValue(undefined);
      mockFs.rename.mockResolvedValue(undefined);

      await manager.createNote({ question: 'Q1', chatId: 'oc_test' });
      const note2 = await manager.createNote({ question: 'Q2', chatId: 'oc_test' });
      await manager.answerNote(note2.id, 'Answer', 'ou_user');

      const stats = await manager.getStats();

      expect(stats.total).toBe(2);
      expect(stats.pending).toBe(1);
      expect(stats.answered).toBe(1);
    });
  });

  describe('persistence', () => {
    it('should save and load notes from storage', async () => {
      let savedData: string | null = null;

      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.readFile.mockRejectedValue(new Error('File not found'));
      mockFs.writeFile.mockImplementation((_path, data) => {
        if (typeof data === 'string') {
          savedData = data;
        }
        return Promise.resolve();
      });
      mockFs.rename.mockResolvedValue(undefined);

      // Create a note
      await manager.createNote({
        question: 'Persistent question',
        chatId: 'oc_test',
      });

      // Verify save was called
      expect(savedData).not.toBeNull();
      const parsed = JSON.parse(savedData!);
      expect(parsed.version).toBe(1);
      expect(parsed.notes.length).toBe(1);
      expect(parsed.notes[0].question).toBe('Persistent question');
    });
  });
});

/**
 * Note Manager - Manages offline notes storage and retrieval.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type {
  OfflineNote,
  NotesStorage,
  ReadNotesOptions,
  OfflineNotesConfig,
} from './types.js';

const logger = createLogger('NoteManager');

/**
 * Default configuration for offline notes.
 */
const DEFAULT_CONFIG: Required<OfflineNotesConfig> = {
  notesDir: 'notes',
  defaultExpiration: 7 * 24 * 60 * 60, // 7 days in seconds
  maxNotes: 1000,
};

/**
 * Current storage format version.
 */
const STORAGE_VERSION = 1;

/**
 * Generate a unique note ID.
 */
function generateNoteId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `note_${timestamp}_${random}`;
}

/**
 * Note Manager - Handles persistence and retrieval of offline notes.
 *
 * Notes are stored in workspace/notes/notes.json as a single JSON file
 * for simplicity and atomic updates.
 */
export class NoteManager {
  private config: Required<OfflineNotesConfig>;
  private notesCache: Map<string, OfflineNote> = new Map();
  private loaded = false;
  private storagePath: string;

  constructor(config?: OfflineNotesConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    const workspaceDir = Config.getWorkspaceDir();
    this.storagePath = path.join(workspaceDir, this.config.notesDir, 'notes.json');
  }

  /**
   * Get the notes directory path.
   */
  private getNotesDir(): string {
    return path.dirname(this.storagePath);
  }

  /**
   * Ensure the notes directory exists.
   */
  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.getNotesDir(), { recursive: true });
  }

  /**
   * Load notes from storage.
   */
  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    try {
      await this.ensureDir();

      try {
        const content = await fs.readFile(this.storagePath, 'utf-8');
        const storage: NotesStorage = JSON.parse(content);

        // Validate version
        if (storage.version !== STORAGE_VERSION) {
          logger.warn({ version: storage.version }, 'Notes storage version mismatch, starting fresh');
          this.notesCache.clear();
        } else {
          // Load into cache
          this.notesCache.clear();
          for (const note of storage.notes) {
            this.notesCache.set(note.id, note);
          }
          logger.info({ count: this.notesCache.size }, 'Notes loaded from storage');
        }
      } catch (error) {
        // File doesn't exist or is invalid, start with empty
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn({ err: error }, 'Failed to load notes, starting fresh');
        }
        this.notesCache.clear();
      }

      this.loaded = true;
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize notes storage');
      throw error;
    }
  }

  /**
   * Save notes to storage.
   */
  private async save(): Promise<void> {
    try {
      await this.ensureDir();

      const storage: NotesStorage = {
        version: STORAGE_VERSION,
        notes: Array.from(this.notesCache.values()),
        updatedAt: new Date().toISOString(),
      };

      // Write atomically using temp file
      const tempPath = `${this.storagePath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(storage, null, 2), 'utf-8');
      await fs.rename(tempPath, this.storagePath);

      logger.debug({ count: this.notesCache.size }, 'Notes saved to storage');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save notes');
      throw error;
    }
  }

  /**
   * Create a new note.
   *
   * @param note - Note data to create
   * @returns The created note with ID
   */
  async createNote(note: Omit<OfflineNote, 'id' | 'createdAt' | 'status'>): Promise<OfflineNote> {
    await this.load();

    const now = new Date().toISOString();
    const newNote: OfflineNote = {
      ...note,
      id: generateNoteId(),
      createdAt: now,
      status: 'pending',
    };

    // Set expiration if specified
    if (note.expiresAt) {
      newNote.expiresAt = note.expiresAt;
    }

    this.notesCache.set(newNote.id, newNote);

    // Enforce max notes limit
    await this.enforceMaxNotes();

    await this.save();

    logger.info({ noteId: newNote.id, chatId: note.chatId }, 'Note created');
    return newNote;
  }

  /**
   * Get a note by ID.
   *
   * @param noteId - Note ID
   * @returns The note or undefined
   */
  async getNote(noteId: string): Promise<OfflineNote | undefined> {
    await this.load();
    return this.notesCache.get(noteId);
  }

  /**
   * Update a note.
   *
   * @param noteId - Note ID
   * @param updates - Fields to update
   * @returns The updated note or undefined if not found
   */
  async updateNote(noteId: string, updates: Partial<OfflineNote>): Promise<OfflineNote | undefined> {
    await this.load();

    const note = this.notesCache.get(noteId);
    if (!note) {
      return undefined;
    }

    const updatedNote: OfflineNote = {
      ...note,
      ...updates,
    };

    this.notesCache.set(noteId, updatedNote);
    await this.save();

    logger.debug({ noteId, updates: Object.keys(updates) }, 'Note updated');
    return updatedNote;
  }

  /**
   * Mark a note as answered.
   *
   * @param noteId - Note ID
   * @param answer - The answer from human
   * @param answeredBy - User who answered
   * @returns The updated note or undefined if not found
   */
  async answerNote(noteId: string, answer: string, answeredBy?: string): Promise<OfflineNote | undefined> {
    return await this.updateNote(noteId, {
      status: 'answered',
      answer,
      answeredBy,
      answeredAt: new Date().toISOString(),
    });
  }

  /**
   * Find a note by message ID.
   *
   * @param messageId - Feishu message ID
   * @returns The note or undefined
   */
  async findByMessageId(messageId: string): Promise<OfflineNote | undefined> {
    await this.load();

    for (const note of this.notesCache.values()) {
      if (note.messageId === messageId) {
        return note;
      }
    }

    return undefined;
  }

  /**
   * Find a note by thread ID.
   *
   * @param threadId - Feishu thread ID
   * @returns The note or undefined
   */
  async findByThreadId(threadId: string): Promise<OfflineNote | undefined> {
    await this.load();

    for (const note of this.notesCache.values()) {
      if (note.threadId === threadId) {
        return note;
      }
    }

    return undefined;
  }

  /**
   * Query notes based on options.
   *
   * @param options - Query options
   * @returns Array of matching notes
   */
  async queryNotes(options: ReadNotesOptions = {}): Promise<OfflineNote[]> {
    await this.load();

    let notes = Array.from(this.notesCache.values());

    // Filter by status
    if (options.status) {
      notes = notes.filter(n => n.status === options.status);
    }

    // Filter by chat ID
    if (options.chatId) {
      notes = notes.filter(n => n.chatId === options.chatId);
    }

    // Filter by date
    if (options.since) {
      const sinceDate = new Date(options.since);
      notes = notes.filter(n => new Date(n.createdAt) >= sinceDate);
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      notes = notes.filter(n =>
        n.tags && options.tags!.some(tag => n.tags!.includes(tag))
      );
    }

    // Exclude expired notes unless explicitly included
    if (!options.includeExpired) {
      const now = new Date();
      notes = notes.filter(n => {
        if (n.status === 'expired') {
          return false;
        }
        if (n.expiresAt && new Date(n.expiresAt) < now) {
          return false;
        }
        return true;
      });
    }

    // Sort by creation date (newest first)
    notes.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Apply limit
    if (options.limit && options.limit > 0) {
      notes = notes.slice(0, options.limit);
    }

    return notes;
  }

  /**
   * Get all pending (unanswered) notes.
   *
   * @param chatId - Optional chat ID filter
   * @returns Array of pending notes
   */
  async getPendingNotes(chatId?: string): Promise<OfflineNote[]> {
    return await this.queryNotes({ status: 'pending', chatId });
  }

  /**
   * Get all answered notes.
   *
   * @param chatId - Optional chat ID filter
   * @returns Array of answered notes
   */
  async getAnsweredNotes(chatId?: string): Promise<OfflineNote[]> {
    return await this.queryNotes({ status: 'answered', chatId });
  }

  /**
   * Mark expired notes.
   *
   * @returns Number of notes marked as expired
   */
  async markExpiredNotes(): Promise<number> {
    await this.load();

    const now = new Date();
    let expiredCount = 0;

    for (const note of this.notesCache.values()) {
      if (note.status === 'pending' && note.expiresAt && new Date(note.expiresAt) < now) {
        note.status = 'expired';
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      await this.save();
      logger.info({ count: expiredCount }, 'Notes marked as expired');
    }

    return expiredCount;
  }

  /**
   * Delete a note.
   *
   * @param noteId - Note ID
   * @returns Whether the note was deleted
   */
  async deleteNote(noteId: string): Promise<boolean> {
    await this.load();

    const deleted = this.notesCache.delete(noteId);
    if (deleted) {
      await this.save();
      logger.info({ noteId }, 'Note deleted');
    }

    return deleted;
  }

  /**
   * Enforce maximum notes limit by removing oldest expired notes first.
   */
  private async enforceMaxNotes(): Promise<void> {
    if (this.notesCache.size <= this.config.maxNotes) {
      return;
    }

    // First, remove expired notes
    await this.markExpiredNotes();

    // If still over limit, remove oldest notes
    if (this.notesCache.size > this.config.maxNotes) {
      const notes = Array.from(this.notesCache.values());
      notes.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      const toRemove = notes.slice(0, this.notesCache.size - this.config.maxNotes);
      for (const note of toRemove) {
        this.notesCache.delete(note.id);
      }

      logger.info({ removed: toRemove.length }, 'Old notes removed to enforce limit');
    }
  }

  /**
   * Clear all notes (use with caution).
   */
  async clearAll(): Promise<void> {
    await this.load();
    this.notesCache.clear();
    await this.save();
    logger.warn('All notes cleared');
  }

  /**
   * Get storage statistics.
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    answered: number;
    expired: number;
  }> {
    await this.load();

    const notes = Array.from(this.notesCache.values());
    return {
      total: notes.length,
      pending: notes.filter(n => n.status === 'pending').length,
      answered: notes.filter(n => n.status === 'answered').length,
      expired: notes.filter(n => n.status === 'expired').length,
    };
  }
}

// Singleton instance
let noteManagerInstance: NoteManager | null = null;

/**
 * Get the singleton NoteManager instance.
 */
export function getNoteManager(): NoteManager {
  if (!noteManagerInstance) {
    noteManagerInstance = new NoteManager();
  }
  return noteManagerInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetNoteManager(): void {
  noteManagerInstance = null;
}

/**
 * Type definitions for Offline Notes system.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 */

/**
 * Status of an offline note.
 */
export type NoteStatus = 'pending' | 'answered' | 'expired';

/**
 * Represents a single offline note.
 */
export interface OfflineNote {
  /** Unique identifier for the note */
  id: string;

  /** The question or message from the agent */
  question: string;

  /** Context information provided by the agent */
  context?: string;

  /** Chat ID where the note was sent */
  chatId: string;

  /** Message ID of the sent note in Feishu */
  messageId?: string;

  /** Thread ID for replies */
  threadId?: string;

  /** Timestamp when the note was created */
  createdAt: string;

  /** Timestamp when the note expires (optional) */
  expiresAt?: string;

  /** Current status of the note */
  status: NoteStatus;

  /** Human's response to the note (if answered) */
  answer?: string;

  /** User who answered the note */
  answeredBy?: string;

  /** Timestamp when the note was answered */
  answeredAt?: string;

  /** Tags for categorization */
  tags?: string[];

  /** Task context - what the agent was working on */
  taskContext?: string;
}

/**
 * Options for creating a new offline note.
 */
export interface LeaveNoteOptions {
  /** The question or message to send */
  question: string;

  /** Additional context for the question */
  context?: string;

  /** Chat ID to send the note to */
  chatId: string;

  /** Parent message ID for thread reply (optional) */
  parentMessageId?: string;

  /** Expiration time in seconds (default: 7 days) */
  expiresIn?: number;

  /** Tags for categorization */
  tags?: string[];

  /** Task context - what the agent is working on */
  taskContext?: string;
}

/**
 * Result of leaving a note.
 */
export interface LeaveNoteResult {
  /** Whether the operation was successful */
  success: boolean;

  /** The ID of the created note */
  noteId?: string;

  /** The message ID in Feishu */
  messageId?: string;

  /** Error message if unsuccessful */
  error?: string;
}

/**
 * Options for reading notes.
 */
export interface ReadNotesOptions {
  /** Filter by status */
  status?: NoteStatus;

  /** Filter by chat ID */
  chatId?: string;

  /** Only notes created after this date */
  since?: string;

  /** Only notes with specific tags */
  tags?: string[];

  /** Maximum number of notes to return */
  limit?: number;

  /** Include expired notes */
  includeExpired?: boolean;
}

/**
 * Result of reading notes.
 */
export interface ReadNotesResult {
  /** Whether the operation was successful */
  success: boolean;

  /** The notes found */
  notes?: OfflineNote[];

  /** Error message if unsuccessful */
  error?: string;
}

/**
 * Configuration for offline notes storage.
 */
export interface OfflineNotesConfig {
  /** Directory to store notes (relative to workspace) */
  notesDir?: string;

  /** Default expiration time in seconds (default: 7 days) */
  defaultExpiration?: number;

  /** Maximum number of notes to keep */
  maxNotes?: number;
}

/**
 * Internal storage format for notes.
 */
export interface NotesStorage {
  /** Version of the storage format */
  version: number;

  /** Array of notes */
  notes: OfflineNote[];

  /** Last updated timestamp */
  updatedAt: string;
}

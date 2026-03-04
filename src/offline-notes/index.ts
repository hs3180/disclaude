/**
 * Offline Notes Module - Non-blocking human interaction system.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 *
 * This module provides tools for agents to communicate with humans
 * without blocking their work:
 *
 * - leave_note: Send a message and continue working
 * - read_notes: Read back responses
 * - check_answers: Check for new answers
 *
 * Usage:
 * ```typescript
 * import { leave_note, read_notes } from './offline-notes';
 *
 * // Leave a note and continue working
 * await leave_note({
 *   question: "What database should I use?",
 *   context: "Building a new microservice",
 *   chatId: "oc_xxx",
 * });
 *
 * // Later, check for answers
 * const result = await read_notes({ status: 'answered' });
 * ```
 */

// Types
export * from './types.js';

// Core functionality
export {
  NoteManager,
  getNoteManager,
  resetNoteManager,
} from './note-manager.js';

// MCP Tools
export {
  leave_note,
  read_notes,
  check_answers,
  get_note,
  delete_note,
  handleNoteReply,
} from './offline-notes-tools.js';

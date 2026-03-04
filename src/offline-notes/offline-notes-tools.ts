/**
 * Offline Notes MCP Tools - Tools for non-blocking human interaction.
 *
 * @see Issue #631 - Agent 不阻塞工作的留言机制
 *
 * These tools allow agents to:
 * - Leave notes for humans without blocking
 * - Read back responses from humans
 * - Manage their offline communication
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import { getNoteManager } from './note-manager.js';
import type {
  LeaveNoteOptions,
  LeaveNoteResult,
  ReadNotesOptions,
  ReadNotesResult,
  OfflineNote,
} from './types.js';

const logger = createLogger('OfflineNotesTools');

/**
 * Format a note as a Feishu card.
 */
function formatNoteAsCard(note: OfflineNote): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: 'markdown',
      content: `**问题:**\n${note.question}`,
    },
  ];

  if (note.context) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**背景信息:**\n${note.context}`,
    });
  }

  if (note.taskContext) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: `**当前任务:**\n${note.taskContext}`,
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'markdown',
    content: `📝 *Note ID: ${note.id}*`,
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '💬 离线提问' },
      template: 'blue',
    },
    elements,
  };
}

/**
 * Format a note as plain text.
 */
function formatNoteAsText(note: OfflineNote): string {
  let text = `💬 离线提问\n\n**问题:**\n${note.question}\n`;

  if (note.context) {
    text += `\n**背景信息:**\n${note.context}\n`;
  }

  if (note.taskContext) {
    text += `\n**当前任务:**\n${note.taskContext}\n`;
  }

  text += `\n📝 Note ID: ${note.id}`;
  return text;
}

/**
 * Tool: Leave a note for human review.
 *
 * Sends a message to a Feishu chat and stores the note for later retrieval.
 * Does NOT wait for a response - the agent can continue working.
 *
 * @param options - Leave note options
 * @returns Result with note ID
 */
export async function leave_note(options: LeaveNoteOptions): Promise<LeaveNoteResult> {
  const { question, context, chatId, parentMessageId, expiresIn, tags, taskContext } = options;

  logger.info({ chatId, questionPreview: question.substring(0, 100) }, 'Leaving note');

  try {
    if (!question) {
      return { success: false, error: 'question is required' };
    }
    if (!chatId) {
      return { success: false, error: 'chatId is required' };
    }

    // Calculate expiration
    const expirationSeconds = expiresIn || 7 * 24 * 60 * 60; // Default: 7 days
    const expiresAt = new Date(Date.now() + expirationSeconds * 1000).toISOString();

    // Create note in storage first
    const noteManager = getNoteManager();
    const note = await noteManager.createNote({
      question,
      context,
      chatId,
      threadId: parentMessageId,
      expiresAt,
      tags,
      taskContext,
    });

    // CLI mode: Log instead of sending
    if (chatId.startsWith('cli-')) {
      logger.info({ noteId: note.id, chatId }, 'CLI mode: Note logged');
      console.log(`\n[Offline Note] ${formatNoteAsText(note)}\n`);
      return { success: true, noteId: note.id };
    }

    // Check Feishu credentials
    const appId = Config.FEISHU_APP_ID;
    const appSecret = Config.FEISHU_APP_SECRET;

    if (!appId || !appSecret) {
      logger.info({ noteId: note.id }, 'Feishu not configured, note stored locally');
      return {
        success: true,
        noteId: note.id,
        messageId: undefined,
      };
    }

    // Create Feishu client
    const client = createFeishuClient(appId, appSecret, {
      domain: lark.Domain.Feishu,
    });

    // Format as card
    const card = formatNoteAsCard(note);
    const content = JSON.stringify(card);

    // Send message
    const messageId: string = '';

    if (parentMessageId) {
      // Reply to thread
      await client.im.message.reply({
        path: { message_id: parentMessageId },
        data: {
          msg_type: 'interactive',
          content,
        },
      });
    } else {
      // New message
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content,
        },
      });
    }

    // Update note with message ID
    await noteManager.updateNote(note.id, { messageId });

    logger.info({ noteId: note.id, messageId, chatId }, 'Note sent to Feishu');

    return {
      success: true,
      noteId: note.id,
      messageId,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error, chatId }, 'Failed to leave note');
    return { success: false, error: errorMessage };
  }
}

/**
 * Tool: Read notes and their responses.
 *
 * Retrieves notes from storage, optionally filtered by status, chat, or date.
 *
 * @param options - Read options
 * @returns Notes with their responses
 */
export async function read_notes(options: ReadNotesOptions = {}): Promise<ReadNotesResult> {
  const { status, chatId, since, tags, limit, includeExpired } = options;

  logger.info({ status, chatId, limit }, 'Reading notes');

  try {
    const noteManager = getNoteManager();
    const notes = await noteManager.queryNotes({
      status,
      chatId,
      since,
      tags,
      limit,
      includeExpired,
    });

    logger.info({ count: notes.length }, 'Notes retrieved');

    return {
      success: true,
      notes,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: error }, 'Failed to read notes');
    return { success: false, error: errorMessage };
  }
}

/**
 * Tool: Check for new answers to pending notes.
 *
 * This is a convenience function that reads only answered notes.
 *
 * @param chatId - Optional chat ID filter
 * @returns Answered notes
 */
export async function check_answers(chatId?: string): Promise<ReadNotesResult> {
  return await read_notes({ status: 'answered', chatId });
}

/**
 * Tool: Get a specific note by ID.
 *
 * @param noteId - Note ID
 * @returns The note if found
 */
export async function get_note(noteId: string): Promise<{
  success: boolean;
  note?: OfflineNote;
  error?: string;
}> {
  try {
    const noteManager = getNoteManager();
    const note = await noteManager.getNote(noteId);

    if (!note) {
      return { success: false, error: `Note not found: ${noteId}` };
    }

    return { success: true, note };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Tool: Delete a note.
 *
 * @param noteId - Note ID
 * @returns Success status
 */
export async function delete_note(noteId: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const noteManager = getNoteManager();
    const deleted = await noteManager.deleteNote(noteId);

    if (!deleted) {
      return { success: false, message: `Note not found: ${noteId}` };
    }

    return { success: true, message: `Note deleted: ${noteId}` };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: errorMessage };
  }
}

/**
 * Handle a reply to a note.
 * Called by the message handler when a reply is detected.
 *
 * @param messageId - Original message ID
 * @param answer - The reply content
 * @param userId - User who replied
 */
export async function handleNoteReply(
  messageId: string,
  answer: string,
  userId?: string
): Promise<boolean> {
  try {
    const noteManager = getNoteManager();
    const note = await noteManager.findByMessageId(messageId);

    if (!note) {
      logger.debug({ messageId }, 'No note found for message ID');
      return false;
    }

    if (note.status !== 'pending') {
      logger.debug({ noteId: note.id, status: note.status }, 'Note already answered or expired');
      return false;
    }

    await noteManager.answerNote(note.id, answer, userId);
    logger.info({ noteId: note.id, userId }, 'Note answered');
    return true;
  } catch (error) {
    logger.error({ err: error, messageId }, 'Failed to handle note reply');
    return false;
  }
}

/**
 * Command handlers for Feishu bot.
 *
 * This module extracts command handling logic from the main bot class
 * to improve modularity and maintainability.
 *
 * Supported commands:
 * - /task <description> - Start structured task workflow (Scout + Planner)
 * - /reset - Clear conversation context by creating new Pilot instance
 *
 * All other messages (including any other potential commands) are passed
 * to the Agent SDK for direct processing.
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommandHandlers');

/**
 * Command handler context
 */
export interface CommandHandlerContext {
  chatId: string;
  sendMessage: (chatId: string, message: string) => Promise<void>;
  resetPilot?: () => void; // Optional callback to reset Pilot instance
}

/**
 * Handle /task command - start structured task workflow (Scout + Planner)
 */
export async function handleTaskCommand(
  context: CommandHandlerContext,
  userRequest: string
): Promise<void> {
  const { chatId, sendMessage } = context;

  logger.info({ chatId, task: userRequest }, 'Task command triggered');

  if (!userRequest) {
    await sendMessage(
      chatId,
      '⚠️ Usage: `/task <your task description>`\n\nExample: `/task Analyze the authentication system`'
    );
    return;
  }

  // Return success - caller will handle the task flow
  // This keeps the module clean by avoiding Config imports
}

/**
 * Handle /reset command - clear conversation context by creating new Pilot instance
 */
export async function handleResetCommand(
  context: CommandHandlerContext
): Promise<void> {
  const { chatId, sendMessage, resetPilot } = context;

  logger.info({ chatId }, 'Reset command triggered');

  if (!resetPilot) {
    await sendMessage(
      chatId,
      '⚠️ Reset functionality is not available in this context.'
    );
    return;
  }

  try {
    // Reset Pilot by creating new instance (clears all context)
    resetPilot();

    await sendMessage(
      chatId,
      '✅ **Conversation reset**\n\nA new conversation session has been started. All previous context has been cleared.'
    );

    logger.info({ chatId }, 'Pilot reset successfully');
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to reset Pilot');

    await sendMessage(
      chatId,
      '❌ Failed to reset conversation. Please try again.'
    );
  }
}

/**
 * Check if text is a /task or /reset command.
 *
 * Note: All other text (including any other "commands") are passed to the SDK.
 */
export function isCommand(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('/task ') || trimmed === '/reset';
}

/**
 * Parse command from text
 */
export function parseCommand(text: string): {
  command: string;
  args: string;
} | null {
  const trimmed = text.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(' ');

  if (spaceIndex === -1) {
    return { command: trimmed, args: '' };
  }

  return {
    command: trimmed.substring(0, spaceIndex),
    args: trimmed.substring(spaceIndex + 1),
  };
}

/**
 * Execute command.
 *
 * Handles /task and /reset commands. Returns true if handled, false otherwise.
 *
 * Note: Any other potential commands are passed to the Agent SDK.
 */
export async function executeCommand(
  context: CommandHandlerContext,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();

  // Handle /task command with arguments
  if (trimmed.startsWith('/task ')) {
    const args = trimmed.substring(6).trim();
    await handleTaskCommand(context, args);
    return true;
  }

  // Handle /reset command (no arguments)
  if (trimmed === '/reset') {
    await handleResetCommand(context);
    return true;
  }

  return false;
}

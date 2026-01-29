/**
 * Command handlers for Feishu bot.
 *
 * This module extracts command handling logic from the main bot class
 * to improve modularity and maintainability.
 */

import { LongTaskManager } from '../long-task/index.js';
import type { SessionManager } from './session.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommandHandlers');

/**
 * Command handler context
 */
export interface CommandHandlerContext {
  chatId: string;
  sendMessage: (chatId: string, message: string) => Promise<void>;
  sessionManager: SessionManager;
  longTaskManagers: Map<string, LongTaskManager>;
}

/**
 * Handle /reset command - clear conversation history
 */
export async function handleResetCommand(
  context: CommandHandlerContext
): Promise<void> {
  const { chatId, sendMessage, sessionManager } = context;

  logger.info({ chatId }, 'Reset command triggered');

  try {
    // Clear session for this chat
    sessionManager.clearSession(chatId);

    await sendMessage(
      chatId,
      '✅ Conversation history cleared. Starting fresh.'
    );
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to clear session');

    await sendMessage(
      chatId,
      '❌ Failed to clear conversation history. Please try again.'
    );
  }
}

/**
 * Handle /status command - show current session and task status
 */
export async function handleStatusCommand(
  context: CommandHandlerContext
): Promise<void> {
  const { chatId, sendMessage, sessionManager, longTaskManagers } = context;

  logger.info({ chatId }, 'Status command triggered');

  try {
    // Get session status
    const sessionId = sessionManager.getSessionId(chatId);
    const sessionStatus = sessionId
      ? `✅ Active session (${sessionId.slice(0, 8)}...)`
      : '⚠️ No active session';

    // Get long task status
    const taskManager = longTaskManagers.get(chatId);
    let taskStatus = '⚠️ No long task is currently running.';

    if (taskManager) {
      const activeTasks = taskManager.getActiveTasks();
      if (activeTasks.size > 0) {
        const tasksInfo = Array.from(activeTasks.values())
          .map(
            (state) =>
              `- **${state.plan.title}**\n  Status: ${state.status}\n  Step: ${state.currentStep}/${state.plan.totalSteps}`
          )
          .join('\n\n');

        taskStatus = `📊 **Long Task Status**\n\nActive tasks: ${activeTasks.size}\n\n${tasksInfo}`;
      }
    }

    // Combine status
    const statusMessage = `📊 **Session Status**\n\n${sessionStatus}\n\n${taskStatus}`;

    await sendMessage(chatId, statusMessage);
  } catch (error) {
    logger.error({ err: error, chatId }, 'Failed to get status');

    await sendMessage(
      chatId,
      '❌ Failed to retrieve status. Please try again.'
    );
  }
}

/**
 * Handle /help command - show help message
 */
export async function handleHelpCommand(
  context: CommandHandlerContext
): Promise<void> {
  const { chatId, sendMessage } = context;

  logger.info({ chatId }, 'Help command triggered');

  const helpMessage = `📖 **Help & Commands**

**Available Commands:**
• /reset - Clear conversation history
• /status - Show session and task status
• /help - Show this help message

**Long Task Mode:**
• /long <task> - Start long task workflow (24h timeout, multi-step)
• /cancel - Cancel running long task

**Examples:**
\`\`\`
/long Analyze the codebase and create comprehensive documentation
/long Refactor the authentication system with tests
/reset
\`\`\`

**Tips:**
• Long tasks can run for up to 24 hours
• Use /cancel to stop a long task
• All other messages are processed by the AI agent
`;

  await sendMessage(chatId, helpMessage);
}

/**
 * Handle /long command - start long task workflow
 */
export async function handleLongTaskCommand(
  context: CommandHandlerContext,
  userRequest: string
): Promise<void> {
  const { chatId, sendMessage, longTaskManagers } = context;

  logger.info({ chatId, task: userRequest }, 'Long task triggered');

  // Check if a task is already running
  const taskManager = longTaskManagers.get(chatId);

  if (taskManager) {
    await sendMessage(
      chatId,
      '⚠️ A long task is already running in this chat. Please wait for it to complete or use /cancel to stop it.'
    );
    return;
  }

  if (!userRequest) {
    await sendMessage(
      chatId,
      '⚠️ Usage: `/long <your task description>`\n\nExample: `/long Analyze the codebase and create documentation`'
    );
    return;
  }

  // Return success - caller should create and start the task manager
  // This is done to avoid importing Config and dependencies in this module
}

/**
 * Handle /cancel command - cancel running long task
 */
export async function handleCancelCommand(
  context: CommandHandlerContext
): Promise<boolean> {
  const { chatId, sendMessage, longTaskManagers } = context;

  logger.info({ chatId }, 'Cancel command triggered');

  const taskManager = longTaskManagers.get(chatId);

  if (!taskManager) {
    await sendMessage(
      chatId,
      '⚠️ No long task is currently running in this chat.'
    );
    return false;
  }

  const cancelled = await taskManager.cancelTask(chatId);

  if (cancelled) {
    await sendMessage(chatId, '✅ Long task cancelled successfully.');
    // Clean up manager after cancellation
    longTaskManagers.delete(chatId);
    return true;
  } else {
    await sendMessage(chatId, '❌ Failed to cancel long task.');
    return false;
  }
}

/**
 * Check if text is a command
 */
export function isCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === '/reset' ||
    trimmed === '/status' ||
    trimmed === '/help' ||
    trimmed === '/cancel' ||
    trimmed.startsWith('/long ')
  );
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
 * Execute command
 *
 * Returns true if command was handled, false otherwise
 */
export async function executeCommand(
  context: CommandHandlerContext,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();

  // Handle simple commands
  if (trimmed === '/reset') {
    await handleResetCommand(context);
    return true;
  }

  if (trimmed === '/status') {
    await handleStatusCommand(context);
    return true;
  }

  if (trimmed === '/help') {
    await handleHelpCommand(context);
    return true;
  }

  if (trimmed === '/cancel') {
    await handleCancelCommand(context);
    return true;
  }

  // Handle commands with arguments
  if (trimmed.startsWith('/long ')) {
    const args = trimmed.substring(6).trim();
    await handleLongTaskCommand(context, args);
    return true;
  }

  return false;
}

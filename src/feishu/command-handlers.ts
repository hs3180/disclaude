/**
 * Command handlers for Feishu bot.
 *
 * This module extracts command handling logic from the main bot class
 * to improve modularity and maintainability.
 */

import { LongTaskManager } from '../long-task/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommandHandlers');

/**
 * Command handler context
 */
export interface CommandHandlerContext {
  chatId: string;
  sendMessage: (chatId: string, message: string) => Promise<void>;
  longTaskManagers: Map<string, LongTaskManager>;
}

/**
 * Handle /status command - show current task status
 */
export async function handleStatusCommand(
  context: CommandHandlerContext
): Promise<void> {
  const { chatId, sendMessage, longTaskManagers } = context;

  logger.info({ chatId }, 'Status command triggered');

  try {
    // Get long task status
    const taskManager = longTaskManagers.get(chatId);
    let statusMessage = '📊 **Current Status**\n\n';

    if (taskManager) {
      const activeTasks = taskManager.getActiveTasks();
      if (activeTasks.size > 0) {
        const tasksInfo = Array.from(activeTasks.values())
          .map(
            (state) =>
              `- **${state.plan.title}**\n  Status: ${state.status}\n  Step: ${state.currentStep}/${state.plan.totalSteps}`
          )
          .join('\n\n');

        statusMessage += `📊 **Long Task Status**\n\nActive tasks: ${activeTasks.size}\n\n${tasksInfo}`;
      } else {
        statusMessage += '⚠️ No long task is currently running.';
      }
    } else {
      statusMessage += '⚠️ No long task is currently running.\n\n💡 Regular tasks run independently and don\'t have persistent status.\n\n📝 **Current Mode**: Direct chat (default)';
    }

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
• /status - Show session and task status
• /help - Show this help message
• /cancel - Cancel running long task

**Task Mode (Structured):**
• /task <task> - Use Scout + Worker/Manager agents (creates Task.md)

**Long Task Mode:**
• /long <task> - Start long task workflow (24h timeout, multi-step)

**Agent Commands:**
• /reset - Reset conversation (handled by Claude agent)

**Direct Chat (Default):**
• Any message without commands - Quick chat with Claude SDK

**Examples:**
\`\`\`
What's the weather today?
/task Analyze the authentication system
/long Refactor user module with tests
/reset
\`\`\`

**How It Works:**
• **Direct chat**: Fast responses, conversation context maintained
• **/task mode**: Structured planning with Task.md, Worker + Manager dialogue
• **/long mode**: Multi-step long-running tasks (24h timeout)
• **/reset**: Clears conversation history (handled by the agent)
`;

  await sendMessage(chatId, helpMessage);
}

/**
 * Handle /task command - start structured task workflow (Scout + Worker/Manager)
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
 * Note: /reset is NOT handled here - it's passed to the agent SDK
 */
export function isCommand(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed === '/status' ||
    trimmed === '/help' ||
    trimmed === '/cancel' ||
    trimmed.startsWith('/long ') ||
    trimmed.startsWith('/task ')
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
 * Note: /reset is passed to the agent SDK, not handled here
 */
export async function executeCommand(
  context: CommandHandlerContext,
  text: string
): Promise<boolean> {
  const trimmed = text.trim();

  // Handle simple commands
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
  if (trimmed.startsWith('/task ')) {
    const args = trimmed.substring(6).trim();
    await handleTaskCommand(context, args);
    return true;
  }

  if (trimmed.startsWith('/long ')) {
    const args = trimmed.substring(6).trim();
    await handleLongTaskCommand(context, args);
    return true;
  }

  return false;
}

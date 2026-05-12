import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import type { TriggerMode } from '../../config/types.js';

/** Typed command for /trigger handler */
type TriggerCommand = ControlCommand<'trigger'>;

/** User-facing messages for mode toggle commands */
interface ModeMessages {
  unavailable: string;
  mentionEnabled: string;
  alwaysEnabled: string;
  autoEnabled: string;
  invalidArgs: string;
}

/** User-facing messages for /trigger command */
const TRIGGER_MESSAGES: ModeMessages = {
  unavailable: '⚠️ 触发模式功能当前不可用。请检查频道配置是否正确。',
  mentionEnabled: '🔕 仅 @触发模式已开启（bot 仅响应 @提及）',
  alwaysEnabled: '🔔 全响应模式已开启（bot 响应所有消息）',
  autoEnabled: '🤖 自动模式已开启（小群全响应，大群仅 @触发）',
  invalidArgs: '⚠️ 无效参数。用法: `/trigger [mention|always|auto]`',
};

/**
 * Parse trigger mode argument (Issue #2291, #3345).
 *
 * Mapping:
 * - 'mention' → 'mention' (mention-only)
 * - 'always' → 'always' (respond to all)
 * - 'auto' → 'auto' (intelligent: respond to all when ≤2 members, mention-only otherwise)
 */
function parseTriggerArg(arg: string): TriggerMode | null {
  switch (arg) {
    case 'mention': return 'mention';
    case 'always': return 'always';
    case 'auto': return 'auto';
    default: return null;
  }
}

/**
 * Get the user-facing message for a given mode.
 */
function getMessageForMode(mode: TriggerMode, messages: ModeMessages): string {
  switch (mode) {
    case 'mention': return messages.mentionEnabled;
    case 'always': return messages.alwaysEnabled;
    case 'auto': return messages.autoEnabled;
  }
}

/**
 * Internal mode toggle handler (Issue #2193, #2291, #3345).
 *
 * Issue #2291: Uses enum-based `getMode`/`setMode` interface.
 * Issue #3345: Supports 'auto' mode.
 * Issue #3529: Typed command data.
 */
function handleModeToggle(
  command: TriggerCommand,
  context: ControlHandlerContext,
  commandName: string,
  messages: ModeMessages,
): ControlResponse {
  // Issue #2291: Use triggerMode (enum-based interface)
  const modeManager = context.triggerMode;

  if (!modeManager) {
    context.logger?.warn(
      { chatId: command.chatId },
      `/${commandName} command received but triggerMode is not configured`
    );
    return {
      success: false,
      message: messages.unavailable,
    };
  }

  const { chatId } = command;
  // Data is now normalized: mode is directly available
  const mode = command.data?.mode;

  if (mode !== undefined) {
    const parsed = parseTriggerArg(mode);
    if (parsed !== null) {
      // Issue #2291/#3345: Use new enum-based interface
      modeManager.setMode(chatId, parsed);
      return {
        success: true,
        message: getMessageForMode(parsed, messages),
      };
    }

    // Invalid argument
    return {
      success: false,
      message: messages.invalidArgs,
    };
  }

  // No argument — cycle through modes: auto → mention → always → auto
  const current = modeManager.getMode(chatId);
  const modeOrder: TriggerMode[] = ['auto', 'mention', 'always'];
  const currentIndex = modeOrder.indexOf(current);
  const newMode = modeOrder[(currentIndex + 1) % modeOrder.length];
  modeManager.setMode(chatId, newMode);
  return {
    success: true,
    message: getMessageForMode(newMode, messages),
  };
}

/**
 * /trigger 命令处理 (Issue #2193: renamed from /passive, #3345: added 'auto' mode)
 */
export const handleTrigger: CommandHandler<'trigger'> = (
  command: ControlCommand<'trigger'>,
  context: ControlHandlerContext
): ControlResponse => handleModeToggle(command, context, 'trigger', TRIGGER_MESSAGES);

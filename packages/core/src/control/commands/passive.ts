import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';
import type { TriggerMode } from '../../config/types.js';

/** User-facing messages for mode toggle commands */
interface ModeMessages {
  unavailable: string;
  mentionEnabled: string;
  alwaysEnabled: string;
  invalidArgs: string;
}

/** User-facing messages for /passive command style */
const PASSIVE_MESSAGES: ModeMessages = {
  unavailable: '⚠️ 被动模式功能当前不可用。请检查频道配置是否正确。',
  mentionEnabled: '🔕 被动模式已开启',
  alwaysEnabled: '🔔 被动模式已关闭',
  invalidArgs: '⚠️ 无效参数。用法: `/passive [on|off]` 或 `/trigger [mention|always]`',
};

/** User-facing messages for /trigger command style */
const TRIGGER_MESSAGES: ModeMessages = {
  unavailable: '⚠️ 触发模式功能当前不可用。请检查频道配置是否正确。',
  mentionEnabled: '🔕 仅 @触发模式已开启（bot 仅响应 @提及）',
  alwaysEnabled: '🔔 全响应模式已开启（bot 响应所有消息）',
  invalidArgs: '⚠️ 无效参数。用法: `/trigger [mention|always]`（`on|off` 仍可使用）',
};

/**
 * Parse trigger mode argument (Issue #2291).
 * Supports new enum values (`mention`, `always`) and legacy aliases (`on`, `off`).
 *
 * Mapping:
 * - 'mention' → 'mention' (mention-only)
 * - 'always' → 'always' (respond to all)
 * - 'on' → 'mention' (legacy: "trigger mode on" = filter active = mention only)
 * - 'off' → 'always' (legacy: "trigger mode off" = filter inactive = respond to all)
 */
function parseTriggerArg(arg: string): TriggerMode | null {
  switch (arg) {
    case 'mention': return 'mention';
    case 'always': return 'always';
    case 'on': return 'mention';   // Legacy alias
    case 'off': return 'always';   // Legacy alias
    default: return null;
  }
}

/**
 * Internal mode toggle handler (Issue #2193, #2291).
 *
 * Shared logic for both `/passive` and `/trigger` commands — only the
 * user-facing messages differ.
 *
 * Issue #2291: Now uses enum-based `getMode`/`setMode` interface,
 * falls back to boolean `isEnabled`/`setEnabled` for backward compat.
 */
function handleModeToggle(
  command: ControlCommand,
  context: ControlHandlerContext,
  commandName: string,
  messages: ModeMessages,
): ControlResponse {
  // Issue #2193: Support both triggerMode (new) and passiveMode (deprecated)
  const modeManager = context.triggerMode ?? context.passiveMode;

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
  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs as string | undefined;

  if (args !== undefined) {
    const mode = parseTriggerArg(args);
    if (mode !== null) {
      // Issue #2291: Use new enum-based interface
      modeManager.setMode(chatId, mode);
      return {
        success: true,
        message: mode === 'mention' ? messages.mentionEnabled : messages.alwaysEnabled,
      };
    }

    // Invalid argument
    return {
      success: false,
      message: messages.invalidArgs,
    };
  }

  // No argument — toggle current state (mention ↔ always)
  const current = modeManager.getMode(chatId);
  const newMode: TriggerMode = current === 'mention' ? 'always' : 'mention';
  modeManager.setMode(chatId, newMode);
  return {
    success: true,
    message: newMode === 'mention' ? messages.mentionEnabled : messages.alwaysEnabled,
  };
}

/**
 * /passive 命令处理 (Issue #2193: alias for /trigger)
 */
export const handlePassive: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => handleModeToggle(command, context, 'passive', PASSIVE_MESSAGES);

/**
 * /trigger 命令处理 (Issue #2193: renamed from /passive)
 */
export const handleTrigger: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => handleModeToggle(command, context, 'trigger', TRIGGER_MESSAGES);

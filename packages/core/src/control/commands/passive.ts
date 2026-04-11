import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/** User-facing messages for mode toggle commands */
interface ModeMessages {
  unavailable: string;
  enabled: string;
  disabled: string;
  invalidArgs: string;
}

/** User-facing messages for /passive command style */
const PASSIVE_MESSAGES: ModeMessages = {
  unavailable: '⚠️ 被动模式功能当前不可用。请检查频道配置是否正确。',
  enabled: '🔕 被动模式已开启',
  disabled: '🔔 被动模式已关闭',
  invalidArgs: '⚠️ 无效参数。用法: `/passive [on|off]` 或 `/trigger [on|off]`',
};

/** User-facing messages for /trigger command style */
const TRIGGER_MESSAGES: ModeMessages = {
  unavailable: '⚠️ 触发模式功能当前不可用。请检查频道配置是否正确。',
  enabled: '🔕 仅 @触发模式已开启（bot 仅响应 @提及）',
  disabled: '🔔 全响应模式已开启（bot 响应所有消息）',
  invalidArgs: '⚠️ 无效参数。用法: `/trigger [on|off]`',
};

/**
 * Internal mode toggle handler (Issue #2193).
 *
 * Shared logic for both `/passive` and `/trigger` commands — only the
 * user-facing messages differ.
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

  if (args === 'on') {
    modeManager.setEnabled(chatId, true);
    return { success: true, message: messages.enabled };
  }

  if (args === 'off') {
    modeManager.setEnabled(chatId, false);
    return { success: true, message: messages.disabled };
  }

  if (args !== undefined && args !== 'on' && args !== 'off') {
    return {
      success: false,
      message: messages.invalidArgs,
    };
  }

  // No argument — toggle current state
  const current = modeManager.isEnabled(chatId);
  modeManager.setEnabled(chatId, !current);
  return {
    success: true,
    message: current ? messages.enabled : messages.disabled,
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

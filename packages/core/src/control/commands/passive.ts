import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /trigger 命令处理 (Issue #2193: renamed from /passive)
 *
 * Supports both `/trigger` and `/passive` for backward compatibility.
 * Maps to ControlCommandType 'trigger'.
 */
export const handlePassive: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { triggerMode } = context;

  if (!triggerMode) {
    context.logger?.warn(
      { chatId: command.chatId },
      '/trigger command received but triggerMode is not configured'
    );
    return {
      success: false,
      message: '⚠️ 触发模式功能当前不可用。请检查频道配置是否正确。',
    };
  }

  const { chatId } = command;
  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs as string | undefined;

  if (args === 'mention') {
    triggerMode.setMode(chatId, 'mention');
    return { success: true, message: '🔕 触发模式已设为 mention（仅 @触发）' };
  }

  if (args === 'always') {
    triggerMode.setMode(chatId, 'always');
    return { success: true, message: '🔔 触发模式已设为 always（自动回复所有消息）' };
  }

  // Backward compat: support old 'on'/'off' args
  if (args === 'on') {
    triggerMode.setMode(chatId, 'mention');
    return { success: true, message: '🔕 触发模式已设为 mention（仅 @触发）' };
  }

  if (args === 'off') {
    triggerMode.setMode(chatId, 'always');
    return { success: true, message: '🔔 触发模式已设为 always（自动回复所有消息）' };
  }

  // 参数校验：有参数但不是有效值时拒绝操作
  if (args !== undefined && args !== 'on' && args !== 'off' && args !== 'mention' && args !== 'always') {
    return {
      success: false,
      message: '⚠️ 无效参数。用法: `/trigger [mention|always]`',
    };
  }

  // 无参数时切换状态
  const current = triggerMode.getMode(chatId);
  const next = current === 'mention' ? 'always' : 'mention';
  triggerMode.setMode(chatId, next);
  return {
    success: true,
    message: next === 'mention'
      ? '🔕 触发模式已设为 mention（仅 @触发）'
      : '🔔 触发模式已设为 always（自动回复所有消息）',
  };
};

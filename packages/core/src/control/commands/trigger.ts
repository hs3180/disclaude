import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/** TriggerMode type */
export type TriggerMode = 'mention' | 'always';

/**
 * /trigger 命令处理
 */
export const handleTrigger: CommandHandler = (
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

  if (args !== undefined && args !== 'mention' && args !== 'always') {
    return {
      success: false,
      message: '⚠️ 无效参数。用法: `/trigger [mention|always]`',
    };
  }

  // No argument: toggle between mention and always
  const current = triggerMode.getMode(chatId);
  const next: TriggerMode = current === 'mention' ? 'always' : 'mention';
  triggerMode.setMode(chatId, next);
  return {
    success: true,
    message: next === 'mention'
      ? '🔕 触发模式已设为 mention（仅 @触发）'
      : '🔔 触发模式已设为 always（自动回复所有消息）',
  };
};

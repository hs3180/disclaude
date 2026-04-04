import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /passive 命令处理
 */
export const handlePassive: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { passiveMode } = context;

  if (!passiveMode) {
    context.logger?.warn(
      { chatId: command.chatId },
      '/passive command received but passiveMode is not configured'
    );
    return {
      success: false,
      message: '⚠️ 被动模式功能当前不可用。请检查频道配置是否正确。',
    };
  }

  const { chatId } = command;
  // Args may be passed as string[] (from Feishu message handler) or string (from REST API)
  const rawArgs = command.data?.args;
  const args: string | undefined = Array.isArray(rawArgs) ? rawArgs[0] : rawArgs as string | undefined;

  if (args === 'on') {
    passiveMode.setEnabled(chatId, true);
    return { success: true, message: '🔕 被动模式已开启' };
  }

  if (args === 'off') {
    passiveMode.setEnabled(chatId, false);
    return { success: true, message: '🔔 被动模式已关闭' };
  }

  // 参数校验：有参数但不是有效值时拒绝操作
  if (args !== undefined && args !== 'on' && args !== 'off') {
    return {
      success: false,
      message: '⚠️ 无效参数。用法: `/passive [on|off]`',
    };
  }

  // 无参数时切换状态
  const current = passiveMode.isEnabled(chatId);
  passiveMode.setEnabled(chatId, !current);
  return {
    success: true,
    message: current ? '🔕 被动模式已开启' : '🔔 被动模式已关闭',
  };
};

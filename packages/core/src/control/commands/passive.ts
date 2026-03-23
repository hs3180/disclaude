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
    return {
      success: true,
      message: '⏳ 被动模式功能尚在开发中，敬请期待。',
    };
  }

  const { chatId } = command;
  const args = command.data?.args as string | undefined;

  if (args === 'on') {
    passiveMode.setEnabled(chatId, true);
    return { success: true, message: '🔕 被动模式已开启' };
  }

  if (args === 'off') {
    passiveMode.setEnabled(chatId, false);
    return { success: true, message: '🔔 被动模式已关闭' };
  }

  // 参数校验：无效参数应报错，而非静默切换
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

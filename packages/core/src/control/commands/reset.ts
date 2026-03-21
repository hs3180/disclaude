import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /reset 命令处理
 */
export const handleReset: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  context.agentPool.reset(command.chatId);
  return {
    success: true,
    message: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
  };
};

/**
 * /restart 命令处理（reset 的别名）
 */
export const handleRestart: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  context.agentPool.reset(command.chatId);
  return {
    success: true,
    message: '🔄 **Agent 实例已重启**\n\n已清除会话状态并重建 Agent。',
  };
};

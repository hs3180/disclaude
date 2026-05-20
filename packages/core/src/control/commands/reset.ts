import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /reset 命令处理
 * Issue #3696: support --no-context flag to skip history loading
 */
export const handleReset: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const skipContext = (command.data as { skipContext?: boolean } | undefined)?.skipContext;
  context.agentPool.reset(command.chatId, skipContext);
  const suffix = skipContext
    ? '\n\n⚠️ 历史上下文已跳过，将以空白状态开始。'
    : '';
  return {
    success: true,
    message: `✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。${suffix}`,
  };
};

/**
 * /restart 命令处理（reset 的别名）
 * Supports same --no-context flag as /reset (Issue #3696).
 */
export const handleRestart: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const skipContext = (command.data as { skipContext?: boolean } | undefined)?.skipContext;
  context.agentPool.reset(command.chatId, skipContext);
  const suffix = skipContext
    ? '\n\n⚠️ 历史上下文已跳过，将以空白状态开始。'
    : '';
  return {
    success: true,
    message: `🔄 **Agent 实例已重启**\n\n已清除会话状态并重建 Agent。${suffix}`,
  };
};

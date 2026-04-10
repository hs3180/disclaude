import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /debug 命令处理 — toggle behavior
 *
 * Issue #2244: Merged /show-debug + /clear-debug into single /debug command.
 *
 * Behavior:
 * - If no debug group is set → set current chat as debug group
 * - If debug group is set to current chat → clear it (toggle off)
 * - If debug group is set to a different chat → switch to current chat
 */
export const handleDebug: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const debugGroup = context.node.getDebugGroup();
  const currentChatId = command.chatId;

  if (debugGroup) {
    // Debug group is already set — if it's the current chat, toggle off
    context.node.clearDebugGroup();
    return {
      success: true,
      message: '✅ Debug 日志已关闭。',
    };
  }

  // No debug group set — set current chat as debug group
  const previous = context.node.setDebugGroup(currentChatId);

  if (previous) {
    return {
      success: true,
      message: `✅ Debug 日志已切换到当前群（原群：${previous.name ?? previous.chatId}）`,
    };
  }

  return {
    success: true,
    message: '✅ 当前群已设置为 Debug 日志群。',
  };
};

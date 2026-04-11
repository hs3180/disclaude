import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /debug 命令处理 — toggle debug group setting.
 *
 * Behavior:
 * - No debug group set → set current chat as debug group
 * - Current chat IS the debug group → clear (toggle off)
 * - Different chat is the debug group → switch to current chat
 *
 * Issue #2244: Merged /show-debug and /clear-debug into single /debug toggle.
 */
export const handleDebug: CommandHandler = (
  command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const debugGroup = context.node.getDebugGroup();
  const { chatId } = command;

  // No debug group set — set current chat
  if (!debugGroup) {
    context.node.setDebugGroup(chatId);
    context.logger?.info({ chatId }, 'Debug group set');
    return {
      success: true,
      message: '🐛 Debug 群已设置为当前群，debug 级别日志将发送到此群。',
    };
  }

  // Current chat IS the debug group — toggle off (clear)
  if (debugGroup.chatId === chatId) {
    const previous = context.node.clearDebugGroup();
    context.logger?.info({ previousChatId: previous?.chatId }, 'Debug group cleared (toggle off)');
    return {
      success: true,
      message: '✅ Debug 群已取消设置。',
    };
  }

  // Different chat is the debug group — switch to current chat
  const previous = context.node.clearDebugGroup();
  context.node.setDebugGroup(chatId);
  context.logger?.info(
    { chatId, previousChatId: previous?.chatId },
    'Debug group switched to current chat'
  );
  return {
    success: true,
    message: '🐛 Debug 群已从另一个群切换到当前群。',
  };
};

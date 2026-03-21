import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /show-debug 命令处理
 */
export const handleShowDebug: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const debugGroup = context.node.getDebugGroup();

  if (debugGroup) {
    return {
      success: true,
      message: `🔍 **Debug 组信息**\n\n**名称**: ${debugGroup.name}\n**设置时间**: ${new Date(debugGroup.setAt).toLocaleString('zh-CN')}`,
    };
  }

  return {
    success: true,
    message: '🔍 当前没有设置 Debug 组。',
  };
};

/**
 * /clear-debug 命令处理
 */
export const handleClearDebug: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  context.node.clearDebugGroup();
  return {
    success: true,
    message: '✅ Debug 组已清除。',
  };
};

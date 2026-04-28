import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /status 命令处理
 *
 * Worker Node architecture has been removed (#2717).
 * Status now shows only the local node information.
 */
export const handleStatus: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { node } = context;

  return {
    success: true,
    message: [
      '📊 **服务状态**',
      '',
      `**节点 ID**: ${node.nodeId}`,
      '**执行节点**: 🏠 本地单节点模式',
    ].join('\n'),
  };
};

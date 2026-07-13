import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /status 命令处理 — shows the local Primary node's status.
 *
 * Single-node only: the Worker Node architecture was removed in #2717
 * (residual cleanup tracked in #4291).
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

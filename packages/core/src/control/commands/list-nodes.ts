import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /list-nodes 命令处理 — lists the execution node(s).
 *
 * Always returns a single local node: the Worker Node architecture was
 * removed in #2717 (residual cleanup tracked in #4291).
 */
export const handleListNodes: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  return {
    success: true,
    message: `📋 **执行节点列表**\n\n🏠 **本地节点** (${context.node.nodeId})\n\n共 1 个节点`,
  };
};

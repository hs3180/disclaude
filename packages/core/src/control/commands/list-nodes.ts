import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /list-nodes 命令处理
 *
 * Worker Node architecture has been removed (#2717).
 * This command now always returns a single-node message.
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

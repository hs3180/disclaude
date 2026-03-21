import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /list-nodes 命令处理
 */
export const handleListNodes: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const nodes = context.node.getExecNodes();

  if (nodes.length === 0) {
    return {
      success: true,
      message: '📋 **执行节点列表**\n\n(无已连接的远程节点，仅本地执行)',
    };
  }

  const lines = nodes
    .map((n) => `${n.isLocal ? '🏠' : '☁️'} **${n.name}** (${n.nodeId})`)
    .join('\n');

  return {
    success: true,
    message: `📋 **执行节点列表**\n\n${lines}\n\n共 ${nodes.length} 个节点`,
  };
};

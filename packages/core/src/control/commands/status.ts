import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /status 命令处理
 */
export const handleStatus: CommandHandler = (
  _command: ControlCommand,
  context: ControlHandlerContext
): ControlResponse => {
  const { node } = context;
  const nodes = node.getExecNodes();
  const nodeCount = nodes.length;
  const localNodeId = node.nodeId;

  const nodeLines = nodes.length > 0
    ? nodes.map((n) => `  - ${n.isLocal ? '🏠' : '☁️'} ${n.name} (${n.nodeId})`).join('\n')
    : '  (无远程节点)';

  return {
    success: true,
    message: [
      '📊 **服务状态**',
      '',
      `**节点 ID**: ${localNodeId}`,
      `**连接节点数**: ${nodeCount}`,
      '**执行节点**:',
      nodeLines,
    ].join('\n'),
  };
};

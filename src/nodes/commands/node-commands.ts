/**
 * Node Commands - Execution node management.
 *
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * List Nodes Command - List all execution nodes.
 */
export class ListNodesCommand implements Command {
  readonly name = 'list-nodes';
  readonly category = 'node' as const;
  readonly description = '列出执行节点';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const nodes = services.getExecNodes();

    if (nodes.length === 0) {
      return { success: true, message: '📋 **执行节点列表**\n\n暂无执行节点' };
    }

    const currentNodeId = services.getChatNodeAssignment(chatId);
    const nodesList = nodes.map(n => {
      const isCurrent = n.nodeId === currentNodeId ? ' ✓ (当前)' : '';
      const localTag = n.isLocal ? ' [本地]' : '';
      return `- ${n.name}${localTag} [${n.status}]${isCurrent} (${n.activeChats} 活跃会话)`;
    }).join('\n');

    return { success: true, message: `📋 **执行节点列表**\n\n${nodesList}` };
  }
}

/**
 * Switch Node Command - Switch to a specific execution node.
 */
export class SwitchNodeCommand implements Command {
  readonly name = 'switch-node';
  readonly category = 'node' as const;
  readonly description = '切换执行节点';
  readonly usage = 'switch-node <nodeId>';

  execute(context: CommandContext): CommandResult {
    const { services, chatId, args } = context;

    if (args.length === 0) {
      const nodes = services.getExecNodes();
      const nodesList = nodes.map(n => `- \`${n.nodeId}\` (${n.name}${n.isLocal ? ', local' : ''})`).join('\n');
      return {
        success: false,
        error: `请指定目标节点ID。\n\n可用节点:\n${nodesList}`,
      };
    }

    const [targetNodeId] = args;
    const success = services.switchChatNode(chatId, targetNodeId);

    if (success) {
      const node = services.getNode(targetNodeId);
      return { success: true, message: `✅ **已切换执行节点**\n\n当前节点: ${node?.name || targetNodeId}` };
    } else {
      return { success: false, error: `切换失败，节点 \`${targetNodeId}\` 不可用` };
    }
  }
}

/**
 * Restart Command - Restart the service.
 */
export class RestartCommand implements Command {
  readonly name = 'restart';
  readonly category = 'node' as const;
  readonly description = '重启服务';

  async execute(context: CommandContext): Promise<CommandResult> {
    await context.services.sendCommand('restart', context.chatId);
    return {
      success: true,
      message: '🔄 **正在重启服务...**',
    };
  }
}

/**
 * Built-in Commands - Default command implementations.
 *
 * These commands are registered by default and provide core functionality.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * Reset Command - Reset the conversation session.
 */
export class ResetCommand implements Command {
  readonly name = 'reset';
  readonly category = 'session' as const;
  readonly description = '重置对话';

  execute(_context: CommandContext): CommandResult {
    // Actual reset is handled by PrimaryNode
    return {
      success: true,
      message: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
    };
  }
}

/**
 * Status Command - Show current status.
 */
export class StatusCommand implements Command {
  readonly name = 'status';
  readonly category = 'session' as const;
  readonly description = '查看状态';

  execute(_context: CommandContext): CommandResult {
    // Actual status is handled by PrimaryNode
    return {
      success: true,
      message: '📊 **状态**\n\n请稍后...',
    };
  }
}

/**
 * Help Command - Show available commands.
 */
export class HelpCommand implements Command {
  readonly name = 'help';
  readonly category = 'session' as const;
  readonly description = '显示帮助';

  private generateHelpText: () => string;

  constructor(generateHelpText: () => string) {
    this.generateHelpText = generateHelpText;
  }

  execute(_context: CommandContext): CommandResult {
    return {
      success: true,
      message: this.generateHelpText(),
    };
  }
}

/**
 * List Nodes Command - List all execution nodes.
 */
export class ListNodesCommand implements Command {
  readonly name = 'list-nodes';
  readonly category = 'node' as const;
  readonly description = '列出执行节点';

  execute(_context: CommandContext): CommandResult {
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '📋 **执行节点列表**\n\n请稍后...',
    };
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
    if (context.args.length === 0) {
      return {
        success: false,
        error: '请指定目标节点 ID。\n\n用法: `/switch-node <nodeId>`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **切换节点中...**',
    };
  }
}

/**
 * Restart Command - Restart the service.
 */
export class RestartCommand implements Command {
  readonly name = 'restart';
  readonly category = 'node' as const;
  readonly description = '重启服务';

  execute(_context: CommandContext): CommandResult {
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **正在重启服务...**',
    };
  }
}

/**
 * Create Group Command - Create a new group chat.
 */
export class CreateGroupCommand implements Command {
  readonly name = 'create-group';
  readonly category = 'group' as const;
  readonly description = '创建群';
  readonly usage = 'create-group <name> <members>';

  execute(context: CommandContext): CommandResult {
    if (context.args.length < 2) {
      return {
        success: false,
        error: '用法: `/create-group <群名称> <成员1,成员2,...>`\n\n示例: `/create-group 讨论组 ou_xxx,ou_yyy`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **创建群中...**',
    };
  }
}

/**
 * Add Member Command - Add a member to a group.
 */
export class AddMemberCommand implements Command {
  readonly name = 'add-member';
  readonly category = 'group' as const;
  readonly description = '添加成员';
  readonly usage = 'add-member <groupId> <member>';

  execute(context: CommandContext): CommandResult {
    if (context.args.length < 2) {
      return {
        success: false,
        error: '用法: `/add-member <群ID> <成员ID>`\n\n示例: `/add-member oc_xxx ou_yyy`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **添加成员中...**',
    };
  }
}

/**
 * Remove Member Command - Remove a member from a group.
 */
export class RemoveMemberCommand implements Command {
  readonly name = 'remove-member';
  readonly category = 'group' as const;
  readonly description = '移除成员';
  readonly usage = 'remove-member <groupId> <member>';

  execute(context: CommandContext): CommandResult {
    if (context.args.length < 2) {
      return {
        success: false,
        error: '用法: `/remove-member <群ID> <成员ID>`\n\n示例: `/remove-member oc_xxx ou_yyy`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **移除成员中...**',
    };
  }
}

/**
 * List Member Command - List members of a group.
 */
export class ListMemberCommand implements Command {
  readonly name = 'list-member';
  readonly category = 'group' as const;
  readonly description = '列出成员';
  readonly usage = 'list-member <groupId>';

  execute(context: CommandContext): CommandResult {
    if (context.args.length < 1) {
      return {
        success: false,
        error: '用法: `/list-member <群ID>`\n\n示例: `/list-member oc_xxx`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **获取成员列表中...**',
    };
  }
}

/**
 * List Group Command - List all managed groups.
 */
export class ListGroupCommand implements Command {
  readonly name = 'list-group';
  readonly category = 'group' as const;
  readonly description = '列出群';

  execute(_context: CommandContext): CommandResult {
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **获取群列表中...**',
    };
  }
}

/**
 * Dissolve Group Command - Dissolve a group.
 */
export class DissolveGroupCommand implements Command {
  readonly name = 'dissolve-group';
  readonly category = 'group' as const;
  readonly description = '解散群';
  readonly usage = 'dissolve-group <groupId>';

  execute(context: CommandContext): CommandResult {
    if (context.args.length < 1) {
      return {
        success: false,
        error: '用法: `/dissolve-group <群ID>`\n\n示例: `/dissolve-group oc_xxx`',
      };
    }
    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **解散群中...**',
    };
  }
}

/**
 * Passive Command - Control passive mode for group chats.
 * Issue #511: Group chat passive mode control
 */
export class PassiveCommand implements Command {
  readonly name = 'passive';
  readonly category = 'group' as const;
  readonly description = '群聊被动模式开关';
  readonly usage = 'passive [on|off|status]';

  execute(context: CommandContext): CommandResult {
    // Default to status if no args
    const subCommand = context.args[0]?.toLowerCase() || 'status';

    // Validate subcommand
    if (!['on', 'off', 'status'].includes(subCommand)) {
      return {
        success: false,
        error: '用法: `/passive [on|off|status]`\n\n- `on` - 开启被动模式（仅响应 @提及）\n- `off` - 关闭被动模式（响应所有消息）\n- `status` - 查看当前状态',
      };
    }

    // Actual implementation is handled by PrimaryNode/CommunicationNode
    return {
      success: true,
      message: '🔄 **被动模式设置中...**',
    };
  }
}

/**
 * Node Command - Unified node management commands.
 * Issue #541: 节点管理指令
 *
 * Subcommands:
 * - list: List all nodes and their status
 * - status [node-id]: View node detailed status
 * - info: View current node info
 * - switch <node-id>: Switch to specified node
 * - auto: Switch to auto-selection mode
 */
export class NodeCommand implements Command {
  readonly name = 'node';
  readonly category = 'node' as const;
  readonly description = '节点管理指令';
  readonly usage = 'node <list|status|info|switch|auto>';

  execute(context: CommandContext): CommandResult {
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: `🖥️ **节点管理指令**

用法: \`/node <子命令>\`

**可用子命令:**
- \`list\` - 列出所有节点及其状态
- \`status [node-id]\` - 查看节点详细状态（不指定则查看当前）
- \`info\` - 查看当前节点信息
- \`switch <node-id>\` - 切换到指定节点
- \`auto\` - 切换到自动选择模式

示例:
\`\`\`
/node list
/node status
/node switch worker-abc123
/node auto
\`\`\``,
      };
    }

    // Validate subcommand
    const validSubcommands = ['list', 'status', 'info', 'switch', 'auto'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: `🔄 **节点命令执行中...**`,
      // Pass through the subcommand and remaining args for PrimaryNode to handle
      data: {
        subcommand: subCommand,
        nodeArgs: context.args.slice(1),
      },
    };
  }
}

/**
 * Register default commands to a registry.
 */
export function registerDefaultCommands(
  registry: { register: (cmd: Command) => void },
  generateHelpText: () => string
): void {
  registry.register(new ResetCommand());
  registry.register(new StatusCommand());
  registry.register(new HelpCommand(generateHelpText));
  registry.register(new ListNodesCommand());
  registry.register(new SwitchNodeCommand());
  registry.register(new RestartCommand());
  registry.register(new CreateGroupCommand());
  registry.register(new AddMemberCommand());
  registry.register(new RemoveMemberCommand());
  registry.register(new ListMemberCommand());
  registry.register(new ListGroupCommand());
  registry.register(new DissolveGroupCommand());
  registry.register(new PassiveCommand());
  // Issue #541: Node management command
  registry.register(new NodeCommand());
}

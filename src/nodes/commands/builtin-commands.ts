/**
 * Built-in Commands - Default command implementations.
 *
 * These commands are registered by default and provide core functionality.
 * Each command uses injected services from CommandContext to execute actual logic.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * Reset Command - Reset the conversation session.
 */
export class ResetCommand implements Command {
  readonly name = 'reset';
  readonly category = 'session' as const;
  readonly description = '重置对话';

  async execute(context: CommandContext): Promise<CommandResult> {
    await context.services.sendCommand('reset', context.chatId);
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

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const status = services.isRunning() ? 'Running' : 'Stopped';
    const execNodesList = services.getExecNodes();
    const execStatus = execNodesList.length > 0
      ? execNodesList.map(n => `${n.name} (${n.status}${n.isLocal ? ', local' : ''})`).join(', ')
      : 'None';
    const channelStatus = services.getChannelStatus();
    const currentNodeId = services.getChatNodeAssignment(chatId);
    const currentNode = execNodesList.find(n => n.nodeId === currentNodeId);

    return {
      success: true,
      message: `📊 **状态**\n\n状态: ${status}\n节点ID: ${services.getLocalNodeId()}\n执行节点: ${execStatus}\n当前节点: ${currentNode?.name || '未分配'}\n通道: ${channelStatus}`,
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

/**
 * Create Group Command - Create a new group chat.
 */
export class CreateGroupCommand implements Command {
  readonly name = 'create-group';
  readonly category = 'group' as const;
  readonly description = '创建群';
  readonly usage = 'create-group <name> <members>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/create-group <群名称> <成员1,成员2,...>`\n\n示例: `/create-group 讨论组 ou_xxx,ou_yyy`',
      };
    }

    const [name, ...restArgs] = args;
    const membersArg = restArgs.join(' ');
    const members = membersArg.split(',').map(m => m.trim()).filter(m => m);

    if (members.length === 0) {
      return { success: false, error: '请至少指定一个成员 (open_id 格式: ou_xxx)' };
    }

    try {
      const client = services.getFeishuClient();
      const chatId = await services.createDiscussionChat(client, { topic: name, members });

      // Register the group
      services.registerGroup({
        chatId,
        name,
        createdAt: Date.now(),
        createdBy: userId,
        initialMembers: members,
      });

      return {
        success: true,
        message: `✅ **群创建成功**\n\n群名称: ${name}\n群 ID: \`${chatId}\`\n成员数: ${members.length}`,
      };
    } catch (error) {
      return { success: false, error: `创建群失败: ${(error as Error).message}` };
    }
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

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/add-member <群ID> <成员ID>`\n\n示例: `/add-member oc_xxx ou_yyy`',
      };
    }

    const [groupId, memberId] = args;

    try {
      const client = services.getFeishuClient();
      await services.addMembers(client, groupId, [memberId]);
      return { success: true, message: `✅ **成员添加成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
    } catch (error) {
      return { success: false, error: `添加成员失败: ${(error as Error).message}` };
    }
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

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/remove-member <群ID> <成员ID>`\n\n示例: `/remove-member oc_xxx ou_yyy`',
      };
    }

    const [groupId, memberId] = args;

    try {
      const client = services.getFeishuClient();
      await services.removeMembers(client, groupId, [memberId]);
      return { success: true, message: `✅ **成员移除成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
    } catch (error) {
      return { success: false, error: `移除成员失败: ${(error as Error).message}` };
    }
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

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/list-member <群ID>`\n\n示例: `/list-member oc_xxx`',
      };
    }

    const [groupId] = args;

    try {
      const client = services.getFeishuClient();
      const members = await services.getMembers(client, groupId);

      if (members.length === 0) {
        return { success: true, message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: 0` };
      }

      const memberList = members.map(m => `- \`${m}\``).join('\n');
      return {
        success: true,
        message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: ${members.length}\n\n${memberList}`,
      };
    } catch (error) {
      return { success: false, error: `获取成员列表失败: ${(error as Error).message}` };
    }
  }
}

/**
 * List Group Command - List all managed groups.
 */
export class ListGroupCommand implements Command {
  readonly name = 'list-group';
  readonly category = 'group' as const;
  readonly description = '列出群';

  execute(context: CommandContext): CommandResult {
    const groups = context.services.listGroups();

    if (groups.length === 0) {
      return { success: true, message: '📋 **管理的群列表**\n\n暂无管理的群' };
    }

    const groupList = groups.map(g => {
      const createdAt = new Date(g.createdAt).toLocaleString('zh-CN');
      return `- **${g.name}** \`${g.chatId}\`\n  创建时间: ${createdAt}\n  初始成员: ${g.initialMembers.length}`;
    }).join('\n\n');

    return {
      success: true,
      message: `📋 **管理的群列表**\n\n群数量: ${groups.length}\n\n${groupList}`,
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

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/dissolve-group <群ID>`\n\n示例: `/dissolve-group oc_xxx`',
      };
    }

    const [groupId] = args;

    try {
      const client = services.getFeishuClient();
      await services.dissolveChat(client, groupId);

      // Unregister the group
      const wasManaged = services.unregisterGroup(groupId);

      return {
        success: true,
        message: `✅ **群解散成功**\n\n群 ID: \`${groupId}\`${wasManaged ? '' : ' (非托管群)'}`,
      };
    } catch (error) {
      return { success: false, error: `解散群失败: ${(error as Error).message}` };
    }
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

    // Actual implementation is handled by PrimaryNode
    return {
      success: true,
      message: '🔄 **被动模式设置中...**',
      // Signal that this needs special handling
      data: { subCommand, needsSpecialHandling: true },
    };
  }
}

/**
 * Set Debug Command - Set the debug group.
 */
export class SetDebugCommand implements Command {
  readonly name = 'set-debug';
  readonly category = 'debug' as const;
  readonly description = '设置调试群';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const previous = services.setDebugGroup(chatId);

    if (previous) {
      return {
        success: true,
        message: `✅ **调试群已转移**\n\n从 \`${previous.chatId}\` 转移至此群 (\`${chatId}\`)`,
      };
    }

    return {
      success: true,
      message: `✅ **调试群已设置**\n\n此群 (\`${chatId}\`) 已设为调试群`,
    };
  }
}

/**
 * Show Debug Command - Show the current debug group.
 */
export class ShowDebugCommand implements Command {
  readonly name = 'show-debug';
  readonly category = 'debug' as const;
  readonly description = '查看调试群';

  execute(context: CommandContext): CommandResult {
    const current = context.services.getDebugGroup();

    if (!current) {
      return {
        success: true,
        message: '📋 **调试群状态**\n\n尚未设置调试群\n\n使用 `/set-debug` 设置当前群为调试群',
      };
    }

    const setAt = new Date(current.setAt).toLocaleString('zh-CN');
    return {
      success: true,
      message: `📋 **调试群状态**\n\n群 ID: \`${current.chatId}\`\n设置时间: ${setAt}`,
    };
  }
}

/**
 * Clear Debug Command - Clear the debug group.
 */
export class ClearDebugCommand implements Command {
  readonly name = 'clear-debug';
  readonly category = 'debug' as const;
  readonly description = '清除调试群';

  execute(context: CommandContext): CommandResult {
    const previous = context.services.clearDebugGroup();

    if (!previous) {
      return {
        success: true,
        message: '📋 **调试群状态**\n\n没有设置调试群，无需清除',
      };
    }

    return {
      success: true,
      message: `✅ **调试群已清除**\n\n原调试群: \`${previous.chatId}\``,
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
      message: '🔄 **节点命令执行中...**',
      // Pass through the subcommand and remaining args for PrimaryNode to handle
      data: {
        subcommand: subCommand,
        nodeArgs: context.args.slice(1),
      },
    };
  }
}

/**
 * Schedule Command - Unified schedule management commands.
 * Issue #469: 定时任务控制指令
 *
 * Subcommands:
 * - list: List all schedules for current chat
 * - status <name>: View schedule details
 * - enable <name>: Enable a schedule
 * - disable <name>: Disable a schedule
 * - run <name>: Manually trigger a schedule
 */
export class ScheduleCommand implements Command {
  readonly name = 'schedule';
  readonly category = 'schedule' as const;
  readonly description = '定时任务管理';
  readonly usage = 'schedule <list|status|enable|disable|run> [name]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: `⏰ **定时任务管理指令**

用法: \`/schedule <子命令> [参数]\`

**可用子命令:**
- \`list\` - 列出当前聊天的所有定时任务
- \`status <任务ID>\` - 查看任务详细状态
- \`enable <任务ID>\` - 启用定时任务
- \`disable <任务ID>\` - 禁用定时任务
- \`run <任务ID>\` - 手动触发定时任务

示例:
\`\`\`
/schedule list
/schedule status schedule-daily-report
/schedule enable schedule-daily-report
/schedule run schedule-daily-report
\`\`\``,
      };
    }

    const { services, chatId } = context;
    const taskId = context.args[1];

    switch (subCommand) {
      case 'list':
        return this.listSchedules(services, chatId);

      case 'status':
        if (!taskId) {
          return { success: false, error: '请指定任务ID\n\n用法: `/schedule status <任务ID>`' };
        }
        return this.showScheduleStatus(services, taskId);

      case 'enable':
        if (!taskId) {
          return { success: false, error: '请指定任务ID\n\n用法: `/schedule enable <任务ID>`' };
        }
        return this.toggleSchedule(services, taskId, true);

      case 'disable':
        if (!taskId) {
          return { success: false, error: '请指定任务ID\n\n用法: `/schedule disable <任务ID>`' };
        }
        return this.toggleSchedule(services, taskId, false);

      case 'run':
        if (!taskId) {
          return { success: false, error: '请指定任务ID\n\n用法: `/schedule run <任务ID>`' };
        }
        return this.triggerSchedule(services, taskId);

      default:
        return {
          success: false,
          error: `未知的子命令: \`${subCommand}\`

可用子命令: \`list\`, \`status\`, \`enable\`, \`disable\`, \`run\``,
        };
    }
  }

  private async listSchedules(
    services: CommandContext['services'],
    chatId: string
  ): Promise<CommandResult> {
    const schedules = await services.listSchedules(chatId);

    if (schedules.length === 0) {
      return { success: true, message: '⏰ **定时任务列表**\n\n当前聊天没有定时任务' };
    }

    const scheduleList = schedules.map(s => {
      const status = s.enabled ? '✅' : '❌';
      const running = s.isRunning ? ' 🔄执行中' : '';
      return `- ${status} \`${s.id}\` - ${s.name} (\`${s.cron}\`)${running}`;
    }).join('\n');

    return {
      success: true,
      message: `⏰ **定时任务列表**\n\n任务数: ${schedules.length}\n\n${scheduleList}`,
    };
  }

  private async showScheduleStatus(
    services: CommandContext['services'],
    taskId: string
  ): Promise<CommandResult> {
    const schedule = await services.getSchedule(taskId);

    if (!schedule) {
      return { success: false, error: `任务 \`${taskId}\` 不存在` };
    }

    const status = schedule.enabled ? '✅ 已启用' : '❌ 已禁用';
    const running = schedule.isRunning ? '\n\n🔄 **正在执行中**' : '';
    const blocking = schedule.blocking ? '是' : '否';

    return {
      success: true,
      message: `⏰ **定时任务详情**

**ID:** \`${schedule.id}\`
**名称:** ${schedule.name}
**状态:** ${status}
**Cron:** \`${schedule.cron}\`
**阻塞模式:** ${blocking}
**聊天ID:** \`${schedule.chatId}\`

**任务内容:**
\`\`\`
${schedule.prompt.slice(0, 200)}${schedule.prompt.length > 200 ? '...' : ''}
\`\`\`${running}`,
    };
  }

  private async toggleSchedule(
    services: CommandContext['services'],
    taskId: string,
    enabled: boolean
  ): Promise<CommandResult> {
    const success = await services.toggleSchedule(taskId, enabled);

    if (!success) {
      return { success: false, error: `任务 \`${taskId}\` 不存在或操作失败` };
    }

    const action = enabled ? '启用' : '禁用';
    return {
      success: true,
      message: `✅ **定时任务已${action}**\n\n任务 \`${taskId}\` 已${action}`,
    };
  }

  private async triggerSchedule(
    services: CommandContext['services'],
    taskId: string
  ): Promise<CommandResult> {
    const success = await services.triggerSchedule(taskId);

    if (!success) {
      return { success: false, error: `任务 \`${taskId}\` 不存在或触发失败` };
    }

    return {
      success: true,
      message: `🚀 **定时任务已触发**\n\n任务 \`${taskId}\` 已开始执行`,
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
  registry.register(new SetDebugCommand());
  registry.register(new ShowDebugCommand());
  registry.register(new ClearDebugCommand());
  // Issue #541: Node management command
  registry.register(new NodeCommand());
  // Issue #469: Schedule management command
  registry.register(new ScheduleCommand());
}

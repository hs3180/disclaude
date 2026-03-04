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
 * Schedule Command - Manage scheduled tasks.
 * Issue #469: 定时任务控制指令
 *
 * Subcommands:
 * - list: List all scheduled tasks
 * - status <name>: View task detailed status
 * - enable <name>: Enable a task
 * - disable <name>: Disable a task
 * - run <name>: Manually trigger a task
 */
export class ScheduleCommand implements Command {
  readonly name = 'schedule';
  readonly category = 'schedule' as const;
  readonly description = '定时任务管理';
  readonly usage = 'schedule <list|status|enable|disable|run>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();
    const { services } = context;

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: `⏰ **定时任务管理**

用法: \`/schedule <子命令> [参数]\`

**可用子命令:**
- \`list\` - 列出所有定时任务
- \`status <名称>\` - 查看任务详细状态
- \`enable <名称>\` - 启用定时任务
- \`disable <名称>\` - 禁用定时任务
- \`run <名称>\` - 手动触发定时任务

示例:
\`\`\`
/schedule list
/schedule status daily-report
/schedule enable daily-report
/schedule disable daily-report
/schedule run daily-report
\`\`\``,
      };
    }

    // Validate subcommand
    const validSubcommands = ['list', 'status', 'enable', 'disable', 'run'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Handle list subcommand
    if (subCommand === 'list') {
      return this.handleList(services);
    }

    // Other subcommands require a task name
    const taskName = context.args[1];
    if (!taskName) {
      return {
        success: false,
        error: `请指定任务名称。\n\n用法: \`/schedule ${subCommand} <名称>\``,
      };
    }

    // Handle other subcommands
    switch (subCommand) {
      case 'status':
        return this.handleStatus(services, taskName);
      case 'enable':
        return this.handleEnable(services, taskName);
      case 'disable':
        return this.handleDisable(services, taskName);
      case 'run':
        return this.handleRun(services, taskName);
      default:
        return { success: false, error: `未知子命令: ${subCommand}` };
    }
  }

  private async handleList(services: CommandContext['services']): Promise<CommandResult> {
    const tasks = await services.listSchedules();

    if (tasks.length === 0) {
      return {
        success: true,
        message: '⏰ **定时任务列表**\n\n暂无定时任务\n\n在 `workspace/schedules/` 目录下创建 `.md` 文件来添加定时任务。',
      };
    }

    const taskList = tasks.map(t => {
      const statusIcon = t.enabled ? (t.isScheduled ? '✅' : '⏸️') : '❌';
      const runningIcon = t.isRunning ? ' 🔄(运行中)' : '';
      return `- ${statusIcon} **${t.name}** \`${t.id}\`
  Cron: \`${t.cron}\`${runningIcon}`;
    }).join('\n\n');

    return {
      success: true,
      message: `⏰ **定时任务列表**\n\n任务数量: ${tasks.length}\n\n${taskList}`,
    };
  }

  private async handleStatus(services: CommandContext['services'], nameOrId: string): Promise<CommandResult> {
    const task = await services.getSchedule(nameOrId);

    if (!task) {
      return {
        success: false,
        error: `未找到任务: \`${nameOrId}\``,
      };
    }

    const statusText = task.enabled
      ? (task.isScheduled ? '✅ 已调度' : '⏸️ 已暂停')
      : '❌ 已禁用';
    const runningText = task.isRunning ? '\n运行状态: 🔄 正在执行' : '';
    const createdText = task.createdAt
      ? `\n创建时间: ${new Date(task.createdAt).toLocaleString('zh-CN')}`
      : '';

    return {
      success: true,
      message: `⏰ **任务详情**

名称: **${task.name}**
ID: \`${task.id}\`
Cron: \`${task.cron}\`
状态: ${statusText}${runningText}${createdText}
目标聊天: \`${task.chatId}\``,
    };
  }

  private async handleEnable(services: CommandContext['services'], nameOrId: string): Promise<CommandResult> {
    const success = await services.enableSchedule(nameOrId);

    if (!success) {
      return {
        success: false,
        error: `启用任务失败: \`${nameOrId}\`\n\n可能原因: 任务不存在或已经是启用状态`,
      };
    }

    return {
      success: true,
      message: `✅ **任务已启用**\n\n任务 \`${nameOrId}\` 已成功启用，将在下一个 cron 周期执行。`,
    };
  }

  private async handleDisable(services: CommandContext['services'], nameOrId: string): Promise<CommandResult> {
    const success = await services.disableSchedule(nameOrId);

    if (!success) {
      return {
        success: false,
        error: `禁用任务失败: \`${nameOrId}\`\n\n可能原因: 任务不存在或已经是禁用状态`,
      };
    }

    return {
      success: true,
      message: `⏸️ **任务已禁用**\n\n任务 \`${nameOrId}\` 已成功禁用，将不再自动执行。`,
    };
  }

  private async handleRun(services: CommandContext['services'], nameOrId: string): Promise<CommandResult> {
    // First get the task to check if it exists
    const task = await services.getSchedule(nameOrId);

    if (!task) {
      return {
        success: false,
        error: `未找到任务: \`${nameOrId}\``,
      };
    }

    if (task.isRunning) {
      return {
        success: false,
        error: `任务 \`${nameOrId}\` 正在执行中，请等待完成后再试。`,
      };
    }

    const success = await services.runSchedule(nameOrId);

    if (!success) {
      return {
        success: false,
        error: `触发任务失败: \`${nameOrId}\``,
      };
    }

    return {
      success: true,
      message: `🚀 **任务已触发**\n\n任务 \`${nameOrId}\` 已手动触发执行。`,
    };
  }
}

/**
 * Task Command - Unified task management commands.
 * Issue #468: 任务控制指令 - deep task 执行管理
 *
 * Subcommands:
 * - <prompt>: Start a new task with the given prompt
 * - status: View current task status
 * - list: List task history
 * - cancel: Cancel current task
 * - pause: Pause current task
 * - resume: Resume paused task
 */
export class TaskCommand implements Command {
  readonly name = 'task';
  readonly category = 'task' as const;
  readonly description = '任务控制指令';
  readonly usage = 'task [<prompt>|status|list|cancel|pause|resume]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, chatId, userId, rawText } = context;
    const subCommand = context.args[0]?.toLowerCase();

    // Status emoji mapping
    const statusEmoji: Record<string, string> = {
      running: '🔄',
      paused: '⏸️',
      completed: '✅',
      cancelled: '❌',
      error: '🔴',
    };

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: `📋 **任务控制指令**

用法: \`/task <子命令>\` 或 \`/task <任务描述>\`

**可用子命令:**
- \`<任务描述>\` - 启动新任务（直接输入任务描述）
- \`status\` - 查看当前任务状态
- \`list\` - 列出任务历史
- \`cancel\` - 取消当前任务
- \`pause\` - 暂停当前任务
- \`resume\` - 恢复暂停的任务

示例:
\`\`\`
/task 分析 src 目录下的文件依赖关系
/task status
/task list
/task cancel
/task pause
/task resume
\`\`\``,
      };
    }

    // Handle subcommands
    if (subCommand === 'status') {
      const currentTask = await services.getCurrentTask();
      if (!currentTask) {
        return {
          success: true,
          message: '📋 **当前任务状态**\n\n没有正在执行的任务',
        };
      }

      const progress = currentTask.progress > 0 ? `\n进度: ${currentTask.progress}%` : '';
      const currentStep = currentTask.currentStep ? `\n当前步骤: ${currentTask.currentStep}` : '';
      const errorMsg = currentTask.error ? `\n错误: ${currentTask.error}` : '';

      return {
        success: true,
        message: `📋 **当前任务状态**\n\n任务 ID: \`${currentTask.id}\`\n状态: ${statusEmoji[currentTask.status] || '❓'} ${currentTask.status}\n描述: ${currentTask.prompt}${progress}${currentStep}${errorMsg}\n创建时间: ${new Date(currentTask.createdAt).toLocaleString('zh-CN')}`,
      };
    }

    if (subCommand === 'list') {
      const tasks = await services.listTaskHistory(10);
      if (tasks.length === 0) {
        return {
          success: true,
          message: '📋 **任务历史**\n\n暂无任务记录',
        };
      }

      const tasksList = tasks.map(t => {
        const emoji = statusEmoji[t.status] || '❓';
        const date = new Date(t.createdAt).toLocaleDateString('zh-CN');
        const truncatedPrompt = t.prompt.length > 30 ? `${t.prompt.substring(0, 30)}...` : t.prompt;
        return `${emoji} \`${t.id}\` - ${truncatedPrompt} (${date})`;
      }).join('\n');

      return {
        success: true,
        message: `📋 **任务历史** (最近 ${tasks.length} 个)\n\n${tasksList}`,
      };
    }

    if (subCommand === 'cancel') {
      try {
        const cancelledTask = await services.cancelTask();
        if (!cancelledTask) {
          return {
            success: true,
            message: '📋 **取消任务**\n\n没有可取消的任务',
          };
        }
        return {
          success: true,
          message: `✅ **任务已取消**\n\n任务 ID: \`${cancelledTask.id}\`\n描述: ${cancelledTask.prompt}`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    if (subCommand === 'pause') {
      try {
        const pausedTask = await services.pauseTask();
        if (!pausedTask) {
          return {
            success: true,
            message: '📋 **暂停任务**\n\n没有可暂停的任务',
          };
        }
        return {
          success: true,
          message: `⏸️ **任务已暂停**\n\n任务 ID: \`${pausedTask.id}\`\n描述: ${pausedTask.prompt}\n\n使用 \`/task resume\` 恢复任务`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    if (subCommand === 'resume') {
      try {
        const resumedTask = await services.resumeTask();
        if (!resumedTask) {
          return {
            success: true,
            message: '📋 **恢复任务**\n\n没有可恢复的任务',
          };
        }
        return {
          success: true,
          message: `▶️ **任务已恢复**\n\n任务 ID: \`${resumedTask.id}\`\n描述: ${resumedTask.prompt}\n\n任务继续执行中...`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    // If not a valid subcommand, treat the entire input as a task prompt
    const prompt = rawText.replace(/^\/task\s+/i, '').trim();

    if (!prompt) {
      return {
        success: false,
        error: '请提供任务描述。\n\n用法: `/task <任务描述>`',
      };
    }

    // Start a new task
    try {
      const task = await services.startTask(prompt, chatId, userId);
      return {
        success: true,
        message: `✅ **任务已启动**\n\n任务 ID: \`${task.id}\`\n描述: ${task.prompt}\n\n任务正在执行中...`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
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
  // Issue #468: Task control command
  registry.register(new TaskCommand());
}

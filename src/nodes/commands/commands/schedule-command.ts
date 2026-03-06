/**
 * Schedule Command - Manage scheduled tasks.
 *
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #469: 定时任务控制指令
 * Issue #869: 冷静期支持
 *
 * Subcommands:
 * - list: List all scheduled tasks
 * - status <name>: View task detailed status
 * - enable <name>: Enable a task
 * - disable <name>: Disable a task
 * - run <name>: Manually trigger a task
 * - cooldown <name>: View/clear cooldown status
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Schedule Command - Manage scheduled tasks.
 * Issue #469: 定时任务控制指令
 * Issue #869: 冷静期支持
 *
 * Subcommands:
 * - list: List all scheduled tasks
 * - status <name>: View task detailed status
 * - enable <name>: Enable a task
 * - disable <name>: Disable a task
 * - run <name>: Manually trigger a task
 * - cooldown <name> [clear]: View or clear cooldown status
 */
export class ScheduleCommand implements Command {
  readonly name = 'schedule';
  readonly category = 'schedule' as const;
  readonly description = '定时任务管理';
  readonly usage = 'schedule <list|status|enable|disable|run|cooldown>';

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
- \`cooldown <名称> [clear]\` - 查看/清除冷静期状态

示例:
\`\`\`
/schedule list
/schedule status daily-report
/schedule enable daily-report
/schedule disable daily-report
/schedule run daily-report
/schedule cooldown daily-report
/schedule cooldown daily-report clear
\`\`\``,
      };
    }

    // Validate subcommand
    const validSubcommands = ['list', 'status', 'enable', 'disable', 'run', 'cooldown'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Handle list subcommand
    if (subCommand === 'list') {
      return await this.handleList(services);
    }

    // Other subcommands require a task name
    const [, taskName] = context.args;
    if (!taskName) {
      return {
        success: false,
        error: `请指定任务名称。\n\n用法: \`/schedule ${subCommand} <名称>\``,
      };
    }

    // Handle other subcommands
    switch (subCommand) {
      case 'status':
        return await this.handleStatus(services, taskName);
      case 'enable':
        return await this.handleEnable(services, taskName);
      case 'disable':
        return await this.handleDisable(services, taskName);
      case 'run':
        return await this.handleRun(services, taskName);
      case 'cooldown':
        return await this.handleCooldown(services, taskName, context.args[2]?.toLowerCase() === 'clear');
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

    // Issue #869: Add cooldown info
    const cooldownText = task.cooldownPeriod
      ? `\n冷静期: ${task.cooldownPeriod / 1000} 秒`
      : '';

    // Get cooldown status if configured
    let cooldownStatusText = '';
    if (task.cooldownPeriod) {
      const cooldownStatus = await services.getScheduleCooldownStatus(task.id, task.cooldownPeriod);
      if (cooldownStatus?.isInCooldown) {
        const remainingMinutes = Math.ceil(cooldownStatus.remainingMs / 60000);
        cooldownStatusText = `\n冷静期状态: 🔒 冷却中 (剩余 ${remainingMinutes} 分钟)`;
      }
    }

    return {
      success: true,
      message: `⏰ **任务详情**

名称: **${task.name}**
ID: \`${task.id}\`
Cron: \`${task.cron}\`
状态: ${statusText}${runningText}${createdText}${cooldownText}${cooldownStatusText}
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

  private async handleCooldown(services: CommandContext['services'], nameOrId: string, clear: boolean): Promise<CommandResult> {
    // First get the task to check if it exists
    const task = await services.getSchedule(nameOrId);

    if (!task) {
      return {
        success: false,
        error: `未找到任务: \`${nameOrId}\``,
      };
    }

    // Handle clear cooldown
    if (clear) {
      const success = await services.clearScheduleCooldown(task.id);
      if (success) {
        return {
          success: true,
          message: `✅ **冷静期已清除**\n\n任务 \`${task.name}\` 的冷静期已清除，可以立即执行。`,
        };
      } else {
        return {
          success: false,
          error: `清除冷静期失败: \`${nameOrId}\`\n\n可能原因: 任务没有冷静期配置或冷静期管理器未初始化`,
        };
      }
    }

    // Get cooldown status
    const status = await services.getScheduleCooldownStatus(task.id, task.cooldownPeriod);

    if (!status) {
      // Cooldown manager not available
      if (task.cooldownPeriod) {
        return {
          success: true,
          message: `⏰ **任务冷静期状态**\n\n任务: \`${task.name}\`\n冷静期配置: ${task.cooldownPeriod / 1000} 秒\n\n⚠️ 冷静期管理器未初始化`,
        };
      } else {
        return {
          success: true,
          message: `⏰ **任务冷静期状态**\n\n任务: \`${task.name}\`\n冷静期: 未配置`,
        };
      }
    }

    if (status.isInCooldown) {
      const remainingMinutes = Math.ceil(status.remainingMs / 60000);
      return {
        success: true,
        message: `⏰ **任务冷静期状态**\n\n任务: \`${task.name}\`\n状态: 🔒 冷静期中\n上次执行: ${status.lastExecutionTime?.toLocaleString('zh-CN')}\n冷静期结束: ${status.cooldownEndsAt?.toLocaleString('zh-CN')}\n剩余时间: ${remainingMinutes} 分钟\n\n使用 \`/schedule cooldown ${nameOrId} clear\` 可清除冷静期`,
      };
    } else {
      return {
        success: true,
        message: `⏰ **任务冷静期状态**\n\n任务: \`${task.name}\`\n状态: ✅ 可执行${status.lastExecutionTime ? `\n上次执行: ${status.lastExecutionTime.toLocaleString('zh-CN')}` : ''}${task.cooldownPeriod ? `\n冷静期配置: ${task.cooldownPeriod / 1000} 秒` : ''}`,
      };
    }
  }
}

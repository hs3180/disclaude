/**
 * Skill Command - Manage Skill Agents.
 *
 * Issue #455: Skill Agent 系统 - 后台执行的独立 Agent 进程
 *
 * Subcommands:
 * - list: List all available skills
 * - run <skill> [input]: Start a skill agent
 * - status <agentId>: View agent status
 * - stop <agentId>: Stop a running agent
 * - agents: List running agents
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Skill Command - Manage Skill Agents.
 *
 * Issue #455: Skill Agent 系统
 *
 * Subcommands:
 * - list: List all available skills
 * - run <skill> [input]: Start a skill agent
 * - status <agentId>: View agent status
 * - stop <agentId>: Stop a running agent
 * - agents: List running agents
 */
export class SkillCommand implements Command {
  readonly name = 'skill';
  readonly category = 'skill' as const;
  readonly description = '技能代理管理';
  readonly usage = 'skill <list|run|status|stop|agents>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();
    const { services } = context;

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: this.getHelpMessage(),
      };
    }

    // Validate subcommand
    const validSubcommands = ['list', 'run', 'status', 'stop', 'agents'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Handle subcommands
    switch (subCommand) {
      case 'list':
        return await this.handleList(services);
      case 'run':
        return await this.handleRun(context);
      case 'status':
        return await this.handleStatus(services, context.args[1]);
      case 'stop':
        return await this.handleStop(services, context.args[1]);
      case 'agents':
        return await this.handleAgents(services);
      default:
        return { success: false, error: `未知子命令: ${subCommand}` };
    }
  }

  private getHelpMessage(): string {
    return `🎯 **技能代理管理**

用法: \`/skill <子命令> [参数]\`

**可用子命令:**
- \`list\` - 列出所有可用技能
- \`run <技能名> [输入]\` - 启动技能代理
- \`status <代理ID>\` - 查看代理状态
- \`stop <代理ID>\` - 停止运行中的代理
- \`agents\` - 列出运行中的代理

示例:
\`\`\`
/skill list
/skill run site-miner https://example.com
/skill status site-miner-abc123
/skill stop site-miner-abc123
/skill agents
\`\`\`

**关于技能代理:**
技能代理是后台运行的独立 Agent 进程，可以执行特定任务而不阻塞主对话。任务完成后会自动发送通知。`;
  }

  private async handleList(services: CommandContext['services']): Promise<CommandResult> {
    const skills = await services.discoverSkills();

    if (skills.length === 0) {
      return {
        success: true,
        message: `🎯 **可用技能列表**

暂无可用技能

在 \`workspace/skills/\` 目录下创建包含 \`SKILL.md\` 文件的子目录来添加技能。`,
      };
    }

    const skillList = skills.map(s => {
      const desc = s.description ? `\n  ${s.description}` : '';
      return `- **${s.name}**${desc}`;
    }).join('\n\n');

    return {
      success: true,
      message: `🎯 **可用技能列表**

技能数量: ${skills.length}

${skillList}`,
    };
  }

  private async handleRun(context: CommandContext): Promise<CommandResult> {
    const { services, chatId } = context;
    const skillName = context.args[1];

    if (!skillName) {
      return {
        success: false,
        error: `请指定技能名称。

用法: \`/skill run <技能名> [输入]\`

使用 \`/skill list\` 查看可用技能。`,
      };
    }

    // Check if skill exists
    const skills = await services.discoverSkills();
    const skill = skills.find(s => s.name === skillName);

    if (!skill) {
      return {
        success: false,
        error: `技能未找到: \`${skillName}\`

使用 \`/skill list\` 查看可用技能。`,
      };
    }

    // Get optional input
    const input = context.args.slice(2).join(' ') || undefined;

    try {
      const agentId = await services.startSkillAgent(skillName, {
        chatId,
        input,
      });

      return {
        success: true,
        message: `🚀 **技能代理已启动**

技能: **${skillName}**
代理ID: \`${agentId}\`
状态: 运行中

任务完成后将自动发送通知。
使用 \`/skill status ${agentId}\` 查看状态。
使用 \`/skill stop ${agentId}\` 停止代理。`,
      };
    } catch (error) {
      return {
        success: false,
        error: `启动技能代理失败: ${(error as Error).message}`,
      };
    }
  }

  private async handleStatus(
    services: CommandContext['services'],
    agentId?: string
  ): Promise<CommandResult> {
    if (!agentId) {
      return {
        success: false,
        error: `请指定代理ID。

用法: \`/skill status <代理ID>\`

使用 \`/skill agents\` 查看运行中的代理。`,
      };
    }

    const status = services.getSkillAgentStatus(agentId);

    if (!status) {
      return {
        success: false,
        error: `代理未找到: \`${agentId}\`

使用 \`/skill agents\` 查看运行中的代理。`,
      };
    }

    const statusEmoji = this.getStatusEmoji(status.status);
    const statusText = this.getStatusText(status.status);
    const duration = status.completedAt
      ? Math.round((status.completedAt - status.startedAt) / 1000)
      : Math.round((Date.now() - status.startedAt) / 1000);

    let message = `📊 **代理状态**

代理ID: \`${status.id}\`
技能: **${status.skillName}**
状态: ${statusEmoji} ${statusText}
运行时间: ${duration}秒
目标聊天: \`${status.chatId}\``;

    if (status.result) {
      message += `\n\n**结果摘要:**\n${status.result}`;
    }

    if (status.error) {
      message += `\n\n**错误信息:**\n${status.error}`;
    }

    return {
      success: true,
      message,
    };
  }

  private async handleStop(
    services: CommandContext['services'],
    agentId?: string
  ): Promise<CommandResult> {
    if (!agentId) {
      return {
        success: false,
        error: `请指定代理ID。

用法: \`/skill stop <代理ID>\`

使用 \`/skill agents\` 查看运行中的代理。`,
      };
    }

    const status = services.getSkillAgentStatus(agentId);

    if (!status) {
      return {
        success: false,
        error: `代理未找到: \`${agentId}\``,
      };
    }

    if (status.status !== 'running' && status.status !== 'starting') {
      return {
        success: false,
        error: `代理已不在运行状态: ${status.status}`,
      };
    }

    const stopped = await services.stopSkillAgent(agentId);

    if (!stopped) {
      return {
        success: false,
        error: `停止代理失败: \`${agentId}\``,
      };
    }

    return {
      success: true,
      message: `⏹️ **代理已停止**

代理ID: \`${agentId}\`
技能: **${status.skillName}**`,
    };
  }

  private async handleAgents(services: CommandContext['services']): Promise<CommandResult> {
    const agents = services.listSkillAgents(false);

    if (agents.length === 0) {
      return {
        success: true,
        message: `📋 **运行中的代理**

暂无运行中的代理

使用 \`/skill run <技能名>\` 启动代理。`,
      };
    }

    const agentList = agents.map(a => {
      const duration = Math.round((Date.now() - a.startedAt) / 1000);
      const statusEmoji = this.getStatusEmoji(a.status);
      return `- ${statusEmoji} **${a.skillName}** \`${a.id}\`
  状态: ${this.getStatusText(a.status)} | 运行: ${duration}秒`;
    }).join('\n\n');

    return {
      success: true,
      message: `📋 **运行中的代理**

代理数量: ${agents.length}

${agentList}`,
    };
  }

  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'starting':
        return '🔄';
      case 'running':
        return '✅';
      case 'completed':
        return '🎉';
      case 'failed':
        return '❌';
      case 'stopped':
        return '⏹️';
      default:
        return '❓';
    }
  }

  private getStatusText(status: string): string {
    switch (status) {
      case 'starting':
        return '启动中';
      case 'running':
        return '运行中';
      case 'completed':
        return '已完成';
      case 'failed':
        return '失败';
      case 'stopped':
        return '已停止';
      default:
        return status;
    }
  }
}

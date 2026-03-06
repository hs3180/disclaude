/**
 * Skill Command - Manage Skill Agents via Feishu commands.
 *
 * Implements the Feishu control interface for Skill Agents as described in Issue #455:
 *
 * Commands:
 * - /skill list - List all available skills and running agents
 * - /skill run <name> [input] - Start a skill agent
 * - /skill stop <agent-id> - Stop a running agent
 * - /skill status [agent-id] - Show agent status
 *
 * @module nodes/commands/commands/skill-command
 */

import type {
  Command,
  CommandContext,
  CommandResult,
  CommandServices,
} from '../types.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('SkillCommand');

/**
 * Skill command for managing Skill Agents.
 *
 * @example
 * ```bash
 * # List all skills
 * /skill list
 *
 * # Run a skill
 * /skill run site-miner Extract product info from https://example.com
 *
 * # Check status
 * /skill status abc-123
 *
 * # Stop an agent
 * /skill stop abc-123
 * ```
 */
export class SkillCommand implements Command {
  readonly name = 'skill';
  readonly category = 'skill' as const;
  readonly description = '管理 Skill Agents（后台执行的技能代理）';
  readonly usage = `/skill <list|run|stop|status> [args...]

子命令:
  list              列出所有可用技能和运行中的 agents
  run <name> [input] 启动一个 skill agent
  stop <agent-id>   停止一个运行中的 agent
  status [agent-id] 查看 agent 状态`;

  execute(context: CommandContext): CommandResult | Promise<CommandResult> {
    const { args, services, chatId } = context;

    if (args.length === 0) {
      return {
        success: false,
        error: `请指定子命令。用法:\n${this.usage}`,
      };
    }

    const subCommand = args[0].toLowerCase();
    const subArgs = args.slice(1);

    switch (subCommand) {
      case 'list':
      case 'ls':
        return this.handleList(services, chatId);

      case 'run':
      case 'start':
        return this.handleRun(subArgs, services, chatId);

      case 'stop':
        return this.handleStop(subArgs, services);

      case 'status':
        return this.handleStatus(subArgs, services);

      default:
        return {
          success: false,
          error: `未知子命令: ${subCommand}\n${this.usage}`,
        };
    }
  }

  /**
   * Handle /skill list command.
   */
  private async handleList(
    services: CommandServices,
    _chatId: string
  ): Promise<CommandResult> {
    try {
      // Get available skills
      const skills = await services.listSkills?.() ?? [];

      // Get running agents
      const agents = services.listSkillAgents?.() ?? [];

      // Build response
      const parts: string[] = ['🎯 **Skill Agent 管理**\n'];

      // Available skills
      if (skills.length > 0) {
        parts.push('**可用技能:**');
        for (const skill of skills) {
          parts.push(`  • ${skill.name} (${skill.domain})`);
        }
        parts.push('');
      } else {
        parts.push('_没有发现可用技能_\n');
      }

      // Running agents
      if (agents.length > 0) {
        parts.push('**运行中的 Agents:**');
        for (const agent of agents) {
          const statusEmoji = this.getStatusEmoji(agent.status);
          const duration = this.formatDuration(agent.startedAt);
          parts.push(
            `  ${statusEmoji} \`${agent.id.slice(0, 8)}\` ${agent.skillName} ` +
            `(${agent.status}, ${duration})`
          );
        }
      }

      // Usage hint
      parts.push(
        '',
        '💡 **使用方法:**',
        '  `/skill run <技能名> [输入]` - 启动一个 skill agent',
        '  `/skill status <agent-id>` - 查看详细状态',
        '  `/skill stop <agent-id>` - 停止 agent'
      );

      return {
        success: true,
        message: parts.join('\n'),
      };
    } catch (error) {
      logger.error({ error }, 'Failed to list skills');
      return {
        success: false,
        error: `获取技能列表失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle /skill run command.
   */
  private async handleRun(
    args: string[],
    services: CommandServices,
    chatId: string
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: '请指定要运行的技能名称。\n用法: /skill run <技能名> [输入]',
      };
    }

    const skillName = args[0];
    const input = args.slice(1).join(' ').trim() || undefined;

    try {
      const agentId = await services.startSkillAgent?.({
        skillName,
        chatId,
        input,
      });

      if (!agentId) {
        return {
          success: false,
          error: 'Skill Agent 服务未初始化',
        };
      }

      return {
        success: true,
        message:
          `🚀 **Skill Agent 已启动**\n\n` +
          `技能: ${skillName}\n` +
          `Agent ID: \`${agentId.slice(0, 8)}\`\n\n` +
          `Agent 将在后台运行，完成后会发送通知。\n` +
          `使用 \`/skill status ${agentId.slice(0, 8)}\` 查看状态。`,
      };
    } catch (error) {
      logger.error({ error, skillName }, 'Failed to start skill agent');
      return {
        success: false,
        error: `启动 Skill Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle /skill stop command.
   */
  private async handleStop(
    args: string[],
    services: CommandServices
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return {
        success: false,
        error: '请指定要停止的 Agent ID。\n用法: /skill stop <agent-id>',
      };
    }

    const agentId = args[0];

    try {
      const stopped = await services.stopSkillAgent?.(agentId);

      if (!stopped) {
        return {
          success: false,
          error: `无法停止 Agent: 未找到或已停止`,
        };
      }

      return {
        success: true,
        message: `⏹️ Agent \`${agentId.slice(0, 8)}\` 已停止`,
      };
    } catch (error) {
      logger.error({ error, agentId }, 'Failed to stop skill agent');
      return {
        success: false,
        error: `停止 Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle /skill status command.
   */
  private handleStatus(
    args: string[],
    services: CommandServices
  ): CommandResult {
    if (args.length === 0) {
      // Show all running agents status
      const agents = services.listSkillAgents?.() ?? [];

      if (agents.length === 0) {
        return {
          success: true,
          message: '没有运行中的 Skill Agents',
        };
      }

      const lines = agents.map((agent) => {
        const emoji = this.getStatusEmoji(agent.status);
        const duration = this.formatDuration(agent.startedAt);
        return (
          `${emoji} \`${agent.id.slice(0, 8)}\` **${agent.skillName}**\n` +
          `   状态: ${agent.status} | 耗时: ${duration}`
        );
      });

      return {
        success: true,
        message: '**运行中的 Skill Agents:**\n\n' + lines.join('\n\n'),
      };
    }

    // Show specific agent status
    const agentId = args[0];
    const agent = services.getSkillAgentInfo?.(agentId);

    if (!agent) {
      return {
        success: false,
        error: `未找到 Agent: ${agentId}`,
      };
    }

    const emoji = this.getStatusEmoji(agent.status);
    const duration = this.formatDuration(agent.startedAt);
    const completedDuration = agent.completedAt
      ? this.formatDuration(agent.completedAt)
      : '';

    const parts = [
      `${emoji} **Skill Agent 状态**`,
      '',
      `**ID:** \`${agent.id.slice(0, 8)}\``,
      `**技能:** ${agent.skillName}`,
      `**状态:** ${agent.status}`,
      `**启动时间:** ${this.formatDateTime(agent.startedAt)}`,
      `**耗时:** ${duration}`,
    ];

    if (agent.completedAt) {
      parts.push(`**完成时间:** ${this.formatDateTime(agent.completedAt)}`);
      parts.push(`**运行时长:** ${completedDuration}`);
    }

    if (agent.error) {
      parts.push('', `**错误:** ${agent.error}`);
    }

    if (agent.result) {
      parts.push('', '**结果:**', agent.result.slice(0, 500));
    }

    return {
      success: true,
      message: parts.join('\n'),
    };
  }

  /**
   * Get emoji for agent status.
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'starting':
        return '🔄';
      case 'running':
        return '▶️';
      case 'completed':
        return '✅';
      case 'failed':
        return '❌';
      case 'stopped':
        return '⏹️';
      default:
        return '❓';
    }
  }

  /**
   * Format duration since a date.
   */
  private formatDuration(date: Date): string {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);

    if (seconds < 60) {
      return `${seconds}秒`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}分钟`;
    }

    const hours = Math.floor(minutes / 60);
    return `${hours}小时${minutes % 60}分钟`;
  }

  /**
   * Format date time for display.
   */
  private formatDateTime(date: Date): string {
    return new Date(date).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}

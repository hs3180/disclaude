/**
 * Skill Command - Skill Agent management commands.
 *
 * Issue #455: Skill Agent System - Independent Agent processes running in background
 *
 * Subcommands:
 * - run <skill-name> [options]: Start a skill agent in background
 * - list: List running skill agents
 * - status <agent-id>: Get status of a specific agent
 * - stop <agent-id>: Stop a running agent
 * - stop-all: Stop all running agents
 *
 * @module nodes/commands/commands/skill-command
 */

import type { Command, CommandContext, CommandResult, SkillAgentInfo } from '../types.js';

/**
 * Skill Command - Manage background skill agents.
 *
 * Issue #455: Skill Agent System
 *
 * Subcommands:
 * - run <skill-name>: Start a skill agent in background
 * - list: List running skill agents
 * - status <agent-id>: Get status of a specific agent
 * - stop <agent-id>: Stop a running agent
 * - stop-all: Stop all running agents
 */
export class SkillCommand implements Command {
  readonly name = 'skill';
  readonly category = 'skill' as const;
  readonly description = 'Skill Agent 管理指令';
  readonly usage = 'skill <run|list|status|stop|stop-all> [options]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args } = context;
    const subCommand = args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: this.getHelpText(),
      };
    }

    // Handle subcommands
    switch (subCommand) {
      case 'run':
        return await this.handleRun(context);

      case 'list':
        return this.handleList(context);

      case 'status':
        return this.handleStatus(context);

      case 'stop':
        return await this.handleStop(context);

      case 'stop-all':
        return await this.handleStopAll(context);

      default:
        return {
          success: false,
          error: `未知子命令: ${subCommand}\n\n${this.getHelpText()}`,
        };
    }
  }

  /**
   * Handle 'run' subcommand - start a skill agent.
   */
  private async handleRun(context: CommandContext): Promise<CommandResult> {
    const { services, chatId, args } = context;

    // args[0] is 'run', args[1] should be skill name
    const [, skillName] = args;

    if (!skillName) {
      return {
        success: false,
        error: '请指定要运行的 skill 名称。\n\n用法: `/skill run <skill-name> [options]`',
      };
    }

    // Parse options
    const options = this.parseRunOptions(args.slice(2));

    try {
      const agentId = await services.startSkillAgent({
        skillName,
        chatId,
        templateVars: options.templateVars,
        timeout: options.timeout,
      });

      return {
        success: true,
        message: `🎯 **Skill Agent 已启动**\n\n` +
          `- **Agent ID**: \`${agentId}\`\n` +
          `- **Skill**: ${skillName}\n` +
          '- **状态**: 运行中\n\n' +
          `使用 \`/skill status ${agentId}\` 查看状态\n` +
          `使用 \`/skill stop ${agentId}\` 停止 agent`,
      };
    } catch (error) {
      return {
        success: false,
        error: `启动 Skill Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle 'list' subcommand - list running agents.
   */
  private handleList(context: CommandContext): CommandResult {
    const { services } = context;

    const agents = services.listSkillAgents();

    if (agents.length === 0) {
      return {
        success: true,
        message: '🎯 **Skill Agents**\n\n暂无运行中的 Skill Agent',
      };
    }

    const agentList = agents.map(a => {
      const statusEmoji = this.getStatusEmoji(a.status);
      const duration = this.getDuration(a);
      return `${statusEmoji} \`${a.id}\` - ${a.skillName} (${duration})`;
    }).join('\n');

    return {
      success: true,
      message: `🎯 **Skill Agents** (共 ${agents.length} 个)\n\n${agentList}`,
    };
  }

  /**
   * Handle 'status' subcommand - get agent status.
   */
  private handleStatus(context: CommandContext): CommandResult {
    const { services, args } = context;

    const [, agentId] = args;

    if (!agentId) {
      return {
        success: false,
        error: '请指定 Agent ID。\n\n用法: `/skill status <agent-id>`',
      };
    }

    const agent = services.getSkillAgent(agentId);

    if (!agent) {
      return {
        success: false,
        error: `未找到 Agent: \`${agentId}\``,
      };
    }

    const statusEmoji = this.getStatusEmoji(agent.status);
    const duration = this.getDuration(agent);
    let details = `- **Agent ID**: \`${agent.id}\`\n` +
      `- **Skill**: ${agent.skillName}\n` +
      `- **状态**: ${statusEmoji} ${agent.status}\n` +
      `- **启动时间**: ${agent.startedAt.toLocaleString('zh-CN')}\n` +
      `- **运行时长**: ${duration}`;

    if (agent.completedAt) {
      details += `\n- **完成时间**: ${agent.completedAt.toLocaleString('zh-CN')}`;
    }

    if (agent.error) {
      details += `\n- **错误**: ${agent.error}`;
    }

    if (agent.output) {
      const truncatedOutput = agent.output.length > 500
        ? `${agent.output.slice(0, 500)}\n... (已截断)`
        : agent.output;
      details += `\n\n**输出:**\n\`\`\`\n${truncatedOutput}\n\`\`\``;
    }

    return {
      success: true,
      message: `🎯 **Skill Agent 状态**\n\n${details}`,
    };
  }

  /**
   * Handle 'stop' subcommand - stop an agent.
   */
  private async handleStop(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    const [, agentId] = args;

    if (!agentId) {
      return {
        success: false,
        error: '请指定 Agent ID。\n\n用法: `/skill stop <agent-id>`',
      };
    }

    try {
      const stopped = await services.stopSkillAgent(agentId);

      if (!stopped) {
        return {
          success: false,
          error: `未找到 Agent: \`${agentId}\``,
        };
      }

      return {
        success: true,
        message: `✅ **Skill Agent 已停止**\n\nAgent ID: \`${agentId}\``,
      };
    } catch (error) {
      return {
        success: false,
        error: `停止 Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle 'stop-all' subcommand - stop all agents.
   */
  private async handleStopAll(context: CommandContext): Promise<CommandResult> {
    const { services } = context;

    try {
      const count = await services.stopAllSkillAgents();

      return {
        success: true,
        message: `✅ **已停止所有 Skill Agents**\n\n共停止 ${count} 个 agent`,
      };
    } catch (error) {
      return {
        success: false,
        error: `停止 Agents 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Parse run options from command arguments.
   */
  private parseRunOptions(args: string[]): {
    templateVars?: Record<string, string>;
    timeout?: number;
  } {
    const result: { templateVars?: Record<string, string>; timeout?: number } = {};
    const templateVars: Record<string, string> = {};

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--timeout' || arg === '-t') {
        const timeout = parseInt(args[++i], 10);
        if (!isNaN(timeout)) {
          result.timeout = timeout * 1000; // Convert to milliseconds
        }
      } else if (arg.startsWith('--')) {
        // Parse --key=value or --key value
        const eqIndex = arg.indexOf('=');
        if (eqIndex > 0) {
          const key = arg.slice(2, eqIndex);
          const value = arg.slice(eqIndex + 1);
          templateVars[key] = value;
        } else {
          const key = arg.slice(2);
          const value = args[++i];
          if (value && !value.startsWith('-')) {
            templateVars[key] = value;
          }
        }
      }
    }

    if (Object.keys(templateVars).length > 0) {
      result.templateVars = templateVars;
    }

    return result;
  }

  /**
   * Get emoji for agent status.
   */
  private getStatusEmoji(status: string): string {
    const emojiMap: Record<string, string> = {
      starting: '🔄',
      running: '▶️',
      completed: '✅',
      failed: '❌',
      stopped: '⏹️',
    };
    return emojiMap[status] || '❓';
  }

  /**
   * Get duration string for an agent.
   */
  private getDuration(agent: SkillAgentInfo): string {
    const end = agent.completedAt || new Date();
    const durationMs = end.getTime() - agent.startedAt.getTime();

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${Math.round(durationMs / 1000)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.round((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }

  /**
   * Get help text.
   */
  private getHelpText(): string {
    return `🎯 **Skill Agent 管理指令**

用法: \`/skill <子命令> [options]\`

**可用子命令:**
- \`run <skill-name> [options]\` - 启动 skill agent
- \`list\` - 列出所有 skill agents
- \`status <agent-id>\` - 查看 agent 状态
- \`stop <agent-id>\` - 停止 agent
- \`stop-all\` - 停止所有 agents

**Run 选项:**
- \`--timeout <seconds>\` 或 \`-t <seconds>\` - 超时时间
- \`--<key>=<value>\` - 传递模板变量

**示例:**
\`\`\`
/skill run playwright-agent
/skill run my-skill --timeout 300 --url https://example.com
/skill list
/skill status skill-abc123
/skill stop skill-abc123
/skill stop-all
\`\`\``;
  }
}

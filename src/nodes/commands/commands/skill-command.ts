/**
 * Skill Command - Skill Agent management commands.
 *
 * Issue #455: Skill Agent 系统 - 后台执行的独立 Agent 进程
 *
 * Subcommands:
 * - list: List available skills
 * - run <skill-name> [input]: Start a skill agent
 * - status [agent-id]: View running agents status
 * - stop <agent-id>: Stop a running agent
 *
 * @module nodes/commands/commands/skill-command
 */

import type { Command, CommandContext, CommandResult, CommandServices } from '../types.js';
import { getSkillAgentManager } from '../../../agents/skill-agent-manager.js';
import { findSkill, listSkills } from '../../../skills/finder.js';

/**
 * Skill Command - Skill Agent management commands.
 *
 * Issue #455: Skill Agent 系统 - 后台执行的独立 Agent 进程
 *
 * Subcommands:
 * - list: List available skills
 * - run <skill-name> [input]: Start a skill agent
 * - status [agent-id]: View running agents status
 * - stop <agent-id>: Stop a running agent
 */
export class SkillCommand implements Command {
  readonly name = 'skill';
  readonly category = 'skill' as const;
  readonly description = '技能 Agent 管理指令';
  readonly usage = 'skill <list|run|status|stop> [options]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services } = context;
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return this.showHelp();
    }

    // Handle subcommands
    switch (subCommand) {
      case 'list':
        return this.handleList(services);
      case 'run':
        return this.handleRun(context);
      case 'status':
        return this.handleStatus(context);
      case 'stop':
        return this.handleStop(context);
      default:
        return {
          success: false,
          error: `Unknown subcommand: ${subCommand}\n\n${this.getHelpText()}`,
        };
    }
  }

  /**
   * Show help message.
   */
  private showHelp(): CommandResult {
    return {
      success: true,
      message: this.getHelpText(),
    };
  }

  /**
   * Get help text.
   */
  private getHelpText(): string {
    return `🎯 **技能 Agent 管理指令**

用法: \`/skill <子命令> [选项]\`

**可用子命令:**
- \`list\` - 列出所有可用技能
- \`run <技能名> [输入]\` - 启动技能 Agent
- \`status [Agent ID]\` - 查看运行状态
- \`stop <Agent ID>\` - 停止运行中的 Agent

**示例:**
\`\`\`
/skill list
/skill run site-miner 提取 https://example.com 的产品列表
/skill status
/skill stop abc-123-def
\`\`\`

**说明:**
技能 Agent 会在后台执行，完成后自动发送结果通知。`;
  }

  /**
   * Handle 'list' subcommand - list available skills.
   */
  private async handleList(_services: CommandServices): Promise<CommandResult> {
    try {
      const skills = await listSkills();

      if (skills.length === 0) {
        return {
          success: true,
          message: '🎯 **可用技能列表**\n\n暂无可用技能',
        };
      }

      const skillsList = skills.map(s => {
        const domainEmoji = s.domain === 'project' ? '📁' : s.domain === 'workspace' ? '💼' : '📦';
        return `${domainEmoji} \`${s.name}\` (${s.domain})`;
      }).join('\n');

      return {
        success: true,
        message: `🎯 **可用技能列表** (共 ${skills.length} 个)\n\n${skillsList}\n\n使用 \`/skill run <技能名> [输入]\` 启动技能 Agent`,
      };
    } catch (error) {
      return {
        success: false,
        error: `获取技能列表失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle 'run' subcommand - start a skill agent.
   */
  private async handleRun(context: CommandContext): Promise<CommandResult> {
    const { chatId, rawText } = context;

    // Parse arguments: /skill run <skill-name> [input]
    const args = rawText.split(/\s+/).slice(2); // Remove '/skill run'
    const skillName = args[0];

    if (!skillName) {
      return {
        success: false,
        error: '请指定要运行的技能名称。\n\n用法: `/skill run <技能名> [输入]`',
      };
    }

    // Check if skill exists
    const skillPath = await findSkill(skillName);
    if (!skillPath) {
      const skills = await listSkills();
      const skillNames = skills.map(s => s.name).join(', ');
      return {
        success: false,
        error: `技能不存在: ${skillName}\n\n可用技能: ${skillNames || '无'}`,
      };
    }

    // Get input (rest of the command)
    const input = args.slice(1).join(' ').trim() || undefined;

    try {
      const manager = getSkillAgentManager();

      // Create send message function from services
      const sendMessage = this.createSendMessage(context.services);

      // Start the skill agent
      const agentId = await manager.start({
        skillName,
        chatId,
        input,
        sendMessage,
      });

      return {
        success: true,
        message: `✅ **技能 Agent 已启动**\n\n技能: \`${skillName}\`\nAgent ID: \`${agentId}\`\n${input ? `输入: ${input.slice(0, 100)}${input.length > 100 ? '...' : ''}\n` : ''}正在后台执行...\n\n使用 \`/skill status ${agentId}\` 查看状态`,
      };
    } catch (error) {
      return {
        success: false,
        error: `启动技能 Agent 失败: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Handle 'status' subcommand - view running agents status.
   */
  private async handleStatus(context: CommandContext): Promise<CommandResult> {
    const { chatId, args } = context;
    const manager = getSkillAgentManager();

    // If agent ID is provided, show specific agent status
    const agentId = args[1];
    if (agentId) {
      const agent = manager.getStatus(agentId);
      if (!agent) {
        return {
          success: true,
          message: `📋 **Agent 状态**\n\n未找到 Agent: \`${agentId}\``,
        };
      }

      return {
        success: true,
        message: this.formatAgentStatus(agent),
      };
    }

    // Otherwise, list all running agents for this chat
    const runningAgents = manager.listRunning(chatId);

    if (runningAgents.length === 0) {
      return {
        success: true,
        message: '📋 **运行中的 Agent**\n\n当前没有运行中的技能 Agent',
      };
    }

    const agentsList = runningAgents.map(a => {
      const statusEmoji = this.getStatusEmoji(a.status);
      const duration = this.formatDuration(a.startedAt, a.completedAt);
      return `${statusEmoji} \`${a.id.slice(0, 8)}...\` - ${a.skillName} (${a.status}, ${duration})`;
    }).join('\n');

    return {
      success: true,
      message: `📋 **运行中的 Agent** (共 ${runningAgents.length} 个)\n\n${agentsList}`,
    };
  }

  /**
   * Handle 'stop' subcommand - stop a running agent.
   */
  private async handleStop(context: CommandContext): Promise<CommandResult> {
    const { args } = context;
    const agentId = args[1];

    if (!agentId) {
      return {
        success: false,
        error: '请指定要停止的 Agent ID。\n\n用法: `/skill stop <Agent ID>`',
      };
    }

    const manager = getSkillAgentManager();
    const stopped = await manager.stop(agentId);

    if (!stopped) {
      return {
        success: false,
        error: `无法停止 Agent: \`${agentId}\`\n\nAgent 可能不存在或已完成`,
      };
    }

    return {
      success: true,
      message: `⏹️ **Agent 停止请求已发送**\n\nAgent ID: \`${agentId}\`\n\nAgent 将在当前操作完成后停止`,
    };
  }

  /**
   * Create send message function from services.
   */
  private createSendMessage(services: CommandServices): (chatId: string, text: string) => Promise<void> {
    return async (chatId: string, text: string) => {
      const client = services.getFeishuClient();
      // Use Feishu API to send message
      await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    };
  }

  /**
   * Get emoji for agent status.
   */
  private getStatusEmoji(status: string): string {
    switch (status) {
      case 'starting': return '🔄';
      case 'running': return '▶️';
      case 'completed': return '✅';
      case 'failed': return '❌';
      case 'cancelled': return '⏹️';
      default: return '❓';
    }
  }

  /**
   * Format agent status for display.
   */
  private formatAgentStatus(agent: {
    id: string;
    skillName: string;
    status: string;
    startedAt: Date;
    completedAt?: Date;
    error?: string;
    result?: string;
  }): string {
    const statusEmoji = this.getStatusEmoji(agent.status);
    const duration = this.formatDuration(agent.startedAt, agent.completedAt);

    let message = `📋 **Agent 状态**\n\n`;
    message += `Agent ID: \`${agent.id}\`\n`;
    message += `技能: \`${agent.skillName}\`\n`;
    message += `状态: ${statusEmoji} ${agent.status}\n`;
    message += `开始时间: ${agent.startedAt.toLocaleString('zh-CN')}\n`;
    message += `持续时间: ${duration}\n`;

    if (agent.error) {
      message += `\n❌ 错误: ${agent.error}\n`;
    }

    if (agent.result) {
      const truncatedResult = agent.result.length > 200
        ? agent.result.slice(0, 200) + '...'
        : agent.result;
      message += `\n📄 结果预览:\n${truncatedResult}\n`;
    }

    return message;
  }

  /**
   * Format duration between two dates.
   */
  private formatDuration(start: Date, end?: Date): string {
    const endTime = end?.getTime() ?? Date.now();
    const durationMs = endTime - start.getTime();

    if (durationMs < 1000) {
      return `${durationMs}ms`;
    } else if (durationMs < 60000) {
      return `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      const minutes = Math.floor(durationMs / 60000);
      const seconds = Math.floor((durationMs % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    }
  }
}

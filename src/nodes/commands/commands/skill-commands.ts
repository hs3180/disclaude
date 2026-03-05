/**
 * Skill Commands - Skill agent management via Feishu.
 *
 * Provides commands for starting, listing, and stopping skill agents
 * that run in the background independently from the main chat.
 *
 * Issue #455: Skill Agent System - 后台执行的独立 Agent 进程
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { SkillAgentManager } from '../../../agents/index.js';
import type { SkillAgentInfo } from '../../../agents/index.js';

const logger = createLogger('SkillCommands');

/**
 * Global skill agent manager instance.
 * Initialized lazily on first use.
 */
let managerInstance: SkillAgentManager | null = null;

/**
 * Get or create the skill agent manager instance.
 */
async function getManager(): Promise<SkillAgentManager> {
  if (!managerInstance) {
    managerInstance = new SkillAgentManager();
    await managerInstance.initialize();
  }
  return managerInstance;
}

/**
 * Format agent info for display.
 */
function formatAgentInfo(agent: SkillAgentInfo, index?: number): string {
  const statusEmojiMap: Record<string, string> = {
    running: '🔄',
    completed: '✅',
    failed: '❌',
    stopped: '⏹️',
  };
  const statusEmoji = statusEmojiMap[agent.status] || '❓';

  const lines = [
    `${index !== undefined ? `${index}. ` : ''}${statusEmoji} **${agent.skillName}** (\`${agent.id}\`)`,
    `   - Status: ${agent.status}`,
    `   - Started: ${new Date(agent.startedAt).toLocaleString()}`,
  ];

  if (agent.endedAt) {
    lines.push(`   - Ended: ${new Date(agent.endedAt).toLocaleString()}`);
  }

  if (agent.error) {
    lines.push(`   - Error: ${agent.error}`);
  }

  if (agent.result) {
    const truncatedResult = agent.result.length > 100
      ? agent.result.slice(0, 100) + '...'
      : agent.result;
    lines.push(`   - Result: ${truncatedResult}`);
  }

  return lines.join('\n');
}

/**
 * Parse template variables from command arguments.
 * Format: --var key=value
 */
function parseTemplateVars(args: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  let i = 0;

  while (i < args.length) {
    if (args[i] === '--var' && i + 1 < args.length) {
      const pair = args[i + 1];
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const key = pair.slice(0, eqIndex);
        const value = pair.slice(eqIndex + 1);
        vars[key] = value;
      }
      i += 2;
    } else {
      i++;
    }
  }

  return vars;
}

/**
 * Get available skills list.
 * Scans the skills directory for available skill files.
 */
function getAvailableSkills(): string[] {
  // This will be populated by scanning the skills directory
  // For now, return common skills
  return [
    'site-miner',
    'evaluator',
    'executor',
    'reporter',
    'schedule-recommend',
    'next-step',
  ];
}

/**
 * Skill Run Command - Start a skill agent in the background.
 *
 * Usage: /skill run <skill-name> [--var key=value]...
 */
export class SkillRunCommand implements Command {
  readonly name = 'skill-run';
  readonly category = 'skill' as const;
  readonly description = '运行技能代理';
  readonly usage = 'skill-run <skill-name> [--var key=value]...';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args, chatId } = context;

    if (args.length === 0) {
      const availableSkills = getAvailableSkills();
      return {
        success: false,
        error: `用法: \`/skill-run <技能名称>\` [选项]\n\n可用技能:\n${availableSkills.map(s => `- ${s}`).join('\n')}\n\n选项:\n\`--var key=value\` - 设置模板变量`,
      };
    }

    const skillName = args[0];

    // Check if skill exists
    const availableSkills = getAvailableSkills();
    if (!availableSkills.includes(skillName)) {
      return {
        success: false,
        error: `未知的技能: ${skillName}\n\n可用技能:\n${availableSkills.map(s => `- ${s}`).join('\n')}`,
      };
    }

    // Parse template variables
    const templateVars = parseTemplateVars(args.slice(1));

    try {
      const manager = await getManager();

      // Start the skill agent
      const agentId = await manager.start({
        skillPath: `skills/${skillName}/SKILL.md`,
        chatId,
        templateVars,
        onComplete: (result: string) => {
          // Log completion - notification will be sent via chatId
          logger.info({ skillName, agentId, resultLength: result.length }, 'Skill agent completed');
        },
        onError: (error: string) => {
          // Log error
          logger.error({ skillName, agentId, error }, 'Skill agent failed');
        },
      });

      return {
        success: true,
        message: `🚀 **技能代理已启动**\n\n技能: ${skillName}\nID: \`${agentId}\`\n\n代理将在后台运行，完成后会发送通知。\n\n查看状态: \`/skill-list\`\n停止代理: \`/skill-stop ${agentId}\``,
      };
    } catch (error) {
      return {
        success: false,
        error: `启动技能代理失败: ${(error as Error).message}`,
      };
    }
  }
}

/**
 * Skill List Command - List all skill agents.
 *
 * Usage: /skill-list [--all]
 */
export class SkillListCommand implements Command {
  readonly name = 'skill-list';
  readonly category = 'skill' as const;
  readonly description = '列出技能代理';
  readonly usage = 'skill-list [--all]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args } = context;
    const showAll = args.includes('--all');

    try {
      const manager = await getManager();

      let agents: SkillAgentInfo[];
      if (showAll) {
        agents = manager.list();
      } else {
        agents = manager.listRunning();
      }

      if (agents.length === 0) {
        return {
          success: true,
          message: `📋 **技能代理列表**\n\n${showAll ? '暂无代理记录' : '暂无运行中的代理'}\n\n使用 \`/skill-run <技能名称>\` 启动新代理`,
        };
      }

      const lines = [
        `📋 **技能代理列表** (${showAll ? '全部' : '运行中'}: ${agents.length})`,
        '',
      ];

      agents.forEach((agent, index) => {
        lines.push(formatAgentInfo(agent, index + 1));
        lines.push('');
      });

      lines.push('---');
      lines.push('停止代理: `/skill-stop <ID>`');
      lines.push('查看全部: `/skill-list --all`');

      return {
        success: true,
        message: lines.join('\n'),
      };
    } catch (error) {
      return {
        success: false,
        error: `获取代理列表失败: ${(error as Error).message}`,
      };
    }
  }
}

/**
 * Skill Stop Command - Stop a running skill agent.
 *
 * Usage: /skill-stop <agent-id>
 */
export class SkillStopCommand implements Command {
  readonly name = 'skill-stop';
  readonly category = 'skill' as const;
  readonly description = '停止技能代理';
  readonly usage = 'skill-stop <agent-id>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args } = context;

    if (args.length === 0) {
      return {
        success: false,
        error: '用法: `/skill-stop <代理ID>`\n\n查看运行中的代理: `/skill-list`',
      };
    }

    const agentId = args[0];

    try {
      const manager = await getManager();
      const stopped = await manager.stop(agentId);

      if (!stopped) {
        const agent = manager.get(agentId);
        if (!agent) {
          return {
            success: false,
            error: `未找到代理: ${agentId}`,
          };
        }
        return {
          success: false,
          error: `代理不在运行中: ${agentId} (状态: ${agent.status})`,
        };
      }

      return {
        success: true,
        message: `⏹️ **技能代理已停止**\n\nID: \`${agentId}\``,
      };
    } catch (error) {
      return {
        success: false,
        error: `停止代理失败: ${(error as Error).message}`,
      };
    }
  }
}

/**
 * Skill Clear Command - Clear agent history.
 *
 * Usage: /skill-clear
 */
export class SkillClearCommand implements Command {
  readonly name = 'skill-clear';
  readonly category = 'skill' as const;
  readonly description = '清除代理历史';

  async execute(_context: CommandContext): Promise<CommandResult> {
    try {
      const manager = await getManager();
      const count = await manager.clearHistory();

      return {
        success: true,
        message: `🗑️ **已清除代理历史**\n\n清除数量: ${count}`,
      };
    } catch (error) {
      return {
        success: false,
        error: `清除历史失败: ${(error as Error).message}`,
      };
    }
  }
}

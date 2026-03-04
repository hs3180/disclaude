/**
 * Expert Command - Manage expert registration and skills.
 *
 * Subcommands:
 * - register: Register as an expert
 * - profile: View your expert profile
 * - skills add <name> <level> [tags]: Add a skill
 * - skills remove <name>: Remove a skill
 * - availability <schedule> [timezone]: Set availability
 *
 * Issue #535: 人类专家注册与技能声明
 */

import type { Command, CommandContext, CommandResult } from '../nodes/commands/types.js';
import type { SkillLevel } from './types.js';
import { getExpertManager } from './expert-manager.js';

/**
 * Parse skill level from string.
 */
function parseSkillLevel(value: string): SkillLevel | null {
  const level = parseInt(value, 10);
  if (level >= 1 && level <= 5) {
    return level as SkillLevel;
  }
  return null;
}

/**
 * Expert Command - Manage expert registration and skills.
 */
export class ExpertCommand implements Command {
  readonly name = 'expert';
  readonly category = 'group' as const;
  readonly description = '专家注册与技能声明';
  readonly usage = 'expert <register|profile|skills|availability>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();
    const { userId } = context;

    // Require userId for all expert operations
    if (!userId) {
      return {
        success: false,
        error: '无法识别用户身份，请在飞书聊天中使用此命令。',
      };
    }

    // If no subcommand, show help
    if (!subCommand) {
      return this.showHelp();
    }

    // Handle subcommands
    switch (subCommand) {
      case 'register':
        return await this.handleRegister(userId, context);
      case 'profile':
        return await this.handleProfile(userId);
      case 'skills':
        return await this.handleSkills(userId, context);
      case 'availability':
        return await this.handleAvailability(userId, context);
      default:
        return {
          success: false,
          error: `未知子命令: \`${subCommand}\`\n\n${this.getUsageText()}`,
        };
    }
  }

  private showHelp(): CommandResult {
    return {
      success: true,
      message: `🎯 **专家注册与技能声明**

用法: \`/expert <子命令> [参数]\`

**可用子命令:**

- \`register\` - 注册为专家
- \`profile\` - 查看自己的专家档案
- \`skills add <技能名> <等级(1-5)> [标签...]\` - 添加技能
- \`skills remove <技能名>\` - 移除技能
- \`availability <时间安排> [时区]\` - 设置可用时间

**示例:**
\`\`\`
/expert register
/expert profile
/expert skills add React 4 frontend web
/expert skills add TypeScript 5
/expert skills remove JavaScript
/expert availability "weekdays 10:00-18:00" Asia/Shanghai
\`\`\`

**技能等级说明:**
- 1: 初学者 - 了解基础概念
- 2: 初级 - 能完成简单任务
- 3: 中级 - 能独立完成常规任务
- 4: 高级 - 能解决复杂问题
- 5: 专家 - 能指导他人`,
    };
  }

  private getUsageText(): string {
    return `用法: \`/expert <register|profile|skills|availability>\`

输入 \`/expert\` 查看完整帮助。`;
  }

  private async handleRegister(userId: string, context: CommandContext): Promise<CommandResult> {
    const manager = getExpertManager();
    const name = context.args.slice(1).join(' ') || undefined;

    try {
      const expert = await manager.registerExpert(userId, name);

      return {
        success: true,
        message: `✅ **专家注册成功**

用户 ID: \`${expert.open_id}\`
${expert.name ? `名称: ${expert.name}` : ''}
注册时间: ${new Date(expert.createdAt).toLocaleString('zh-CN')}

使用以下命令添加技能:
- \`/expert skills add <技能名> <等级(1-5)> [标签...]\``,
      };
    } catch (error) {
      return {
        success: false,
        error: `注册失败: ${(error as Error).message}`,
      };
    }
  }

  private async handleProfile(userId: string): Promise<CommandResult> {
    const manager = getExpertManager();
    const expert = await manager.getExpert(userId);

    if (!expert) {
      return {
        success: true,
        message: `📋 **专家档案**

您尚未注册为专家。

使用 \`/expert register\` 注册。`,
      };
    }

    const skillsList = expert.skills.length > 0
      ? expert.skills.map(s => {
          const tags = s.tags && s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
          return `- **${s.name}** (等级 ${s.level})${tags}`;
        }).join('\n')
      : '- 暂无技能';

    const availability = expert.availability
      ? `\n可用时间: ${expert.availability.schedule}${expert.availability.timezone ? ` (${expert.availability.timezone})` : ''}`
      : '';

    return {
      success: true,
      message: `📋 **专家档案**

用户 ID: \`${expert.open_id}\`
${expert.name ? `名称: ${expert.name}` : ''}
注册时间: ${new Date(expert.createdAt).toLocaleString('zh-CN')}
更新时间: ${new Date(expert.updatedAt).toLocaleString('zh-CN')}

**技能列表:**
${skillsList}${availability}`,
    };
  }

  private async handleSkills(userId: string, context: CommandContext): Promise<CommandResult> {
    const action = context.args[1]?.toLowerCase();

    if (!action) {
      return {
        success: false,
        error: `请指定操作: \`add\` 或 \`remove\`\n\n${this.getUsageText()}`,
      };
    }

    const manager = getExpertManager();

    // Check if user is registered
    const expert = await manager.getExpert(userId);
    if (!expert) {
      return {
        success: false,
        error: '您尚未注册为专家。请先使用 `/expert register` 注册。',
      };
    }

    if (action === 'add') {
      return await this.handleSkillsAdd(userId, context, manager);
    } else if (action === 'remove') {
      return await this.handleSkillsRemove(userId, context, manager);
    } else {
      return {
        success: false,
        error: `未知操作: \`${action}\`\n\n可用操作: \`add\`, \`remove\``,
      };
    }
  }

  private async handleSkillsAdd(
    userId: string,
    context: CommandContext,
    manager: ReturnType<typeof getExpertManager>
  ): Promise<CommandResult> {
    const [, , skillName, levelStr, ...tags] = context.args;

    if (!skillName) {
      return {
        success: false,
        error: '请指定技能名称。\n\n用法: `/expert skills add <技能名> <等级(1-5)> [标签...]`',
      };
    }

    if (!levelStr) {
      return {
        success: false,
        error: '请指定技能等级 (1-5)。\n\n用法: `/expert skills add <技能名> <等级(1-5)> [标签...]`',
      };
    }

    const level = parseSkillLevel(levelStr);
    if (!level) {
      return {
        success: false,
        error: '技能等级必须是 1-5 之间的整数。\n\n**等级说明:**\n- 1: 初学者\n- 2: 初级\n- 3: 中级\n- 4: 高级\n- 5: 专家',
      };
    }

    try {
      const updatedExpert = await manager.addSkill(userId, skillName, level, tags.length > 0 ? tags : undefined);

      if (!updatedExpert) {
        return {
          success: false,
          error: '添加技能失败，请重试。',
        };
      }

      const tagsText = tags.length > 0 ? ` 标签: [${tags.join(', ')}]` : '';
      return {
        success: true,
        message: `✅ **技能添加成功**

技能: **${skillName}**
等级: ${level}${tagsText}

使用 \`/expert profile\` 查看完整档案。`,
      };
    } catch (error) {
      return {
        success: false,
        error: `添加技能失败: ${(error as Error).message}`,
      };
    }
  }

  private async handleSkillsRemove(
    userId: string,
    context: CommandContext,
    manager: ReturnType<typeof getExpertManager>
  ): Promise<CommandResult> {
    const [, , skillName] = context.args;

    if (!skillName) {
      return {
        success: false,
        error: '请指定要移除的技能名称。\n\n用法: `/expert skills remove <技能名>`',
      };
    }

    try {
      const updatedExpert = await manager.removeSkill(userId, skillName);

      if (!updatedExpert) {
        return {
          success: false,
          error: '移除技能失败，请重试。',
        };
      }

      return {
        success: true,
        message: `✅ **技能已移除**

技能: **${skillName}**

使用 \`/expert profile\` 查看完整档案。`,
      };
    } catch (error) {
      return {
        success: false,
        error: `移除技能失败: ${(error as Error).message}`,
      };
    }
  }

  private async handleAvailability(userId: string, context: CommandContext): Promise<CommandResult> {
    const manager = getExpertManager();

    // Check if user is registered
    const expert = await manager.getExpert(userId);
    if (!expert) {
      return {
        success: false,
        error: '您尚未注册为专家。请先使用 `/expert register` 注册。',
      };
    }

    const [, schedule, timezone] = context.args;

    if (!schedule) {
      return {
        success: false,
        error: '请指定可用时间安排。\n\n用法: `/expert availability <时间安排> [时区]`\n\n示例: `/expert availability "weekdays 10:00-18:00" Asia/Shanghai`',
      };
    }

    try {
      const updatedExpert = await manager.setAvailability(userId, {
        schedule,
        timezone: timezone || 'Asia/Shanghai',
      });

      if (!updatedExpert) {
        return {
          success: false,
          error: '设置可用时间失败，请重试。',
        };
      }

      return {
        success: true,
        message: `✅ **可用时间已设置**

时间安排: ${schedule}
时区: ${timezone || 'Asia/Shanghai'}

使用 \`/expert profile\` 查看完整档案。`,
      };
    } catch (error) {
      return {
        success: false,
        error: `设置可用时间失败: ${(error as Error).message}`,
      };
    }
  }
}

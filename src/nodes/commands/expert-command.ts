/**
 * Expert Command - Human expert registration and skill declaration.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import type { Command, CommandContext, CommandResult } from './types.js';
import { getExpertRegistry } from '../../human-loop/index.js';
import type { SkillDefinition } from '../../human-loop/types.js';

/**
 * Expert Command - Unified expert management commands.
 *
 * Subcommands:
 * - register: Register as an expert
 * - profile: View your expert profile
 * - skills add <name> <level> [tags]: Add a skill
 * - skills remove <name>: Remove a skill
 * - availability <schedule>: Set availability
 * - list: List all registered experts
 */
export class ExpertCommand implements Command {
  readonly name = 'expert';
  readonly category = 'expert' as const;
  readonly description = '专家注册与技能声明';
  readonly usage = 'expert <register|profile|skills|availability|list>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const subCommand = context.args[0]?.toLowerCase();

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: this.getHelpText(),
      };
    }

    // Validate subcommand
    const validSubcommands = ['register', 'profile', 'skills', 'availability', 'list'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`

可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Get userId from context
    const userId = context.userId;
    if (!userId && subCommand !== 'list') {
      return {
        success: false,
        error: '无法获取用户 ID，请确保在支持用户身份的渠道中使用此命令',
      };
    }

    const registry = getExpertRegistry();

    switch (subCommand) {
      case 'register':
        return this.handleRegister(registry, userId!, context.args.slice(1));

      case 'profile':
        return this.handleProfile(registry, userId!);

      case 'skills':
        return this.handleSkills(registry, userId!, context.args.slice(1));

      case 'availability':
        return this.handleAvailability(registry, userId!, context.args.slice(1));

      case 'list':
        return this.handleList(registry);

      default:
        return { success: false, error: '未知子命令' };
    }
  }

  /**
   * Get help text for the command.
   */
  private getHelpText(): string {
    return `👨‍💼 **专家管理指令**

用法: \`/expert <子命令>\`

**可用子命令:**

- \`register [name]\` - 注册为专家
- \`profile\` - 查看您的专家档案
- \`skills add <技能名> <等级(1-5)> [标签...]\` - 添加技能
- \`skills remove <技能名>\` - 移除技能
- \`availability <时间安排>\` - 设置可用时间
- \`list\` - 列出所有注册的专家

**示例:**
\`\`\`
/expert register 张三
/expert skills add React 4 frontend web
/expert skills add TypeScript 5
/expert skills remove JavaScript
/expert availability weekdays 10:00-18:00
/expert profile
/expert list
\`\`\`

**技能等级说明:**
- 1: 入门 - 了解基础概念
- 2: 初级 - 能完成简单任务
- 3: 中级 - 独立完成常规工作
- 4: 高级 - 解决复杂问题
- 5: 专家 - 精通并有深度理解`;
  }

  /**
   * Handle register subcommand.
   */
  private async handleRegister(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string,
    args: string[]
  ): Promise<CommandResult> {
    // Name can be provided as argument or use userId as default
    const name = args.length > 0 ? args.join(' ') : `专家_${userId.slice(-6)}`;

    const result = await registry.register(userId, name);

    if (result.success) {
      if (result.isNew) {
        return {
          success: true,
          message: `✅ **注册成功**

欢迎，${name}！您已成功注册为专家。

接下来您可以：
1. 添加您的技能：\`/expert skills add <技能名> <等级>\`
2. 设置可用时间：\`/expert availability <时间安排>\`
3. 查看您的档案：\`/expert profile\``,
        };
      } else {
        return {
          success: true,
          message: `✅ **已注册**

您已经是注册专家了。名称已更新为：${name}

查看您的档案：\`/expert profile\``,
        };
      }
    }

    return { success: false, error: result.error || '注册失败' };
  }

  /**
   * Handle profile subcommand.
   */
  private async handleProfile(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string
  ): Promise<CommandResult> {
    const profile = await registry.getProfile(userId);

    if (!profile) {
      return {
        success: false,
        error: '您还未注册为专家\n\n请先使用 `/expert register [名称]` 注册',
      };
    }

    const skillsText = profile.skills.length > 0
      ? profile.skills.map(s => {
          const levelBar = '⭐'.repeat(s.level) + '☆'.repeat(5 - s.level);
          const tags = s.tags && s.tags.length > 0 ? ` [${s.tags.join(', ')}]` : '';
          return `- **${s.name}** ${levelBar} (Level ${s.level})${tags}`;
        }).join('\n')
      : '_暂无技能声明_';

    const availabilityText = profile.availability
      ? `📅 **可用时间:** ${profile.availability.schedule || '未设置'}\n🌍 **时区:** ${profile.availability.timezone || '未设置'}`
      : '_未设置可用时间_';

    return {
      success: true,
      message: `👨‍💼 **专家档案**

**名称:** ${profile.name}
**ID:** \`${profile.open_id}\`

**技能列表:**
${skillsText}

**可用性:**
${availabilityText}

---
💡 使用 \`/expert skills add <技能> <等级>\` 添加技能
💡 使用 \`/expert availability <时间>\` 设置可用时间`,
    };
  }

  /**
   * Handle skills subcommand.
   */
  private async handleSkills(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string,
    args: string[]
  ): Promise<CommandResult> {
    const action = args[0]?.toLowerCase();

    if (!action || !['add', 'remove'].includes(action)) {
      return {
        success: false,
        error: `用法:
- \`/expert skills add <技能名> <等级(1-5)> [标签...]\`
- \`/expert skills remove <技能名>\``,
      };
    }

    if (action === 'add') {
      return this.handleAddSkill(registry, userId, args.slice(1));
    } else {
      return this.handleRemoveSkill(registry, userId, args.slice(1));
    }
  }

  /**
   * Handle add skill.
   */
  private async handleAddSkill(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/expert skills add <技能名> <等级(1-5)> [标签...]`\n\n示例: `/expert skills add React 4 frontend web`',
      };
    }

    const skillName = args[0];
    const level = parseInt(args[1], 10);

    if (isNaN(level) || level < 1 || level > 5) {
      return {
        success: false,
        error: '技能等级必须是 1-5 之间的数字\n\n等级说明:\n- 1: 入门\n- 2: 初级\n- 3: 中级\n- 4: 高级\n- 5: 专家',
      };
    }

    const tags = args.length > 2 ? args.slice(2) : undefined;

    const skill: SkillDefinition = {
      name: skillName,
      level,
      tags,
    };

    const result = await registry.addSkill(userId, skill);

    if (result.success) {
      const levelBar = '⭐'.repeat(level) + '☆'.repeat(5 - level);
      const tagsText = tags ? ` [${tags.join(', ')}]` : '';
      const actionText = result.isUpdate ? '更新' : '添加';

      return {
        success: true,
        message: `✅ **技能${actionText}成功**

**${skillName}** ${levelBar} (Level ${level})${tagsText}`,
      };
    }

    return { success: false, error: result.error || '添加技能失败' };
  }

  /**
   * Handle remove skill.
   */
  private async handleRemoveSkill(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/expert skills remove <技能名>`\n\n示例: `/expert skills remove React`',
      };
    }

    const skillName = args[0];
    const result = await registry.removeSkill(userId, skillName);

    if (result.success) {
      return {
        success: true,
        message: `✅ **技能已移除**

已移除技能: **${skillName}**`,
      };
    }

    return { success: false, error: result.error || '移除技能失败' };
  }

  /**
   * Handle availability subcommand.
   */
  private async handleAvailability(
    registry: ReturnType<typeof getExpertRegistry>,
    userId: string,
    args: string[]
  ): Promise<CommandResult> {
    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/expert availability <时间安排>`\n\n示例:\n- `/expert availability weekdays 10:00-18:00`\n- `/expert availability Mon-Fri 9:00-17:00 Asia/Shanghai`',
      };
    }

    // Parse availability string
    const availabilityStr = args.join(' ');

    // Simple parsing - just use the whole string as schedule
    // In a more sophisticated implementation, we could parse timezone separately
    const availability = {
      schedule: availabilityStr,
      timezone: 'Asia/Shanghai', // Default timezone
    };

    const result = await registry.setAvailability(userId, availability);

    if (result.success) {
      return {
        success: true,
        message: `✅ **可用时间已设置**

📅 **时间安排:** ${availability.schedule}
🌍 **时区:** ${availability.timezone}`,
      };
    }

    return { success: false, error: result.error || '设置可用时间失败' };
  }

  /**
   * Handle list subcommand.
   */
  private async handleList(
    registry: ReturnType<typeof getExpertRegistry>
  ): Promise<CommandResult> {
    const experts = await registry.getAll();

    if (experts.length === 0) {
      return {
        success: true,
        message: '👨‍💼 **专家列表**\n\n暂无注册专家。\n\n使用 `/expert register` 成为第一位专家！',
      };
    }

    const expertsList = experts.map(e => {
      const skillsText = e.skills.length > 0
        ? e.skills.map(s => `${s.name}(Lv.${s.level})`).join(', ')
        : '无技能';
      return `- **${e.name}** \`${e.open_id.slice(0, 12)}...\`\n  技能: ${skillsText}`;
    }).join('\n\n');

    return {
      success: true,
      message: `👨‍💼 **专家列表** (${experts.length} 位)

${expertsList}

---
💡 使用 \`/expert profile\` 查看您的档案`,
    };
  }
}

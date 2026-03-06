/**
 * Expert Commands - Human expert registration and skill management.
 *
 * Provides commands for:
 * - /expert register - Register as an expert
 * - /expert profile - View expert profile
 * - /expert skills add - Add a skill
 * - /expert skills remove - Remove a skill
 * - /expert availability - Set availability
 * - /expert search - Search experts by skill
 * - /expert list - List all experts
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import { getExpertService, type SkillLevel, type SkillDeclaration } from '../../../experts/index.js';

/**
 * Parse skill level from string.
 */
function parseSkillLevel(level: string): SkillLevel | undefined {
  const num = parseInt(level, 10);
  if (num >= 1 && num <= 5) {
    return num as SkillLevel;
  }
  return undefined;
}

/**
 * Format expert profile for display.
 */
function formatProfile(profile: ReturnType<typeof getExpertService>['getExpert'] extends (...args: any) => infer R ? R : never): string {
  if (!profile) {
    return '❌ 未找到专家档案';
  }

  const lines: string[] = [
    `👤 **${profile.name}**`,
    `   ID: \`${profile.userId}\``,
  ];

  if (profile.availability) {
    lines.push(`   ⏰ 可用时间: ${profile.availability}`);
  }

  if (profile.skills.length > 0) {
    lines.push('   🎯 技能:');
    for (const skill of profile.skills) {
      const stars = '⭐'.repeat(skill.level);
      const tags = skill.tags?.length ? ` [${skill.tags.join(', ')}]` : '';
      lines.push(`      - ${skill.name} ${stars}${tags}`);
    }
  } else {
    lines.push('   🎯 技能: 暂无');
  }

  lines.push(`   📅 注册时间: ${new Date(profile.registeredAt).toLocaleDateString('zh-CN')}`);

  return lines.join('\n');
}

/**
 * Expert Command - Multi-function expert management.
 *
 * Usage:
 * - /expert register [name] - Register as expert
 * - /expert profile - View your profile
 * - /expert skills add <name> <level> [tags...] - Add skill
 * - /expert skills remove <name> - Remove skill
 * - /expert availability <hours> - Set availability
 * - /expert search <skill> [minLevel] - Search experts
 * - /expert list - List all experts
 */
export class ExpertCommand implements Command {
  readonly name = 'expert';
  readonly category = 'skill' as const;
  readonly description = '专家注册与技能管理';
  readonly usage = 'expert <register|profile|skills|availability|search|list>';

  execute(context: CommandContext): CommandResult {
    const { args, userId } = context;

    if (!userId) {
      return { success: false, error: '❌ 需要用户身份才能执行此命令' };
    }

    const subCommand = args[0]?.toLowerCase();

    switch (subCommand) {
      case 'register':
        return this.handleRegister(context);
      case 'profile':
        return this.handleProfile(context);
      case 'skills':
        return this.handleSkills(context);
      case 'availability':
        return this.handleAvailability(context);
      case 'search':
        return this.handleSearch(context);
      case 'list':
        return this.handleList(context);
      default:
        return {
          success: false,
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /expert register [名字] - 注册为专家\n- /expert profile - 查看档案\n- /expert skills add <技能> <等级1-5> [标签...]\n- /expert skills remove <技能>\n- /expert availability <时间>\n- /expert search <技能> [最低等级]\n- /expert list - 列出所有专家`,
        };
    }
  }

  private handleRegister(context: CommandContext): CommandResult {
    const { args, userId } = context;
    const expertService = getExpertService();

    // Get name from args or use userId as default
    const name = args.slice(1).join(' ') || `专家_${userId!.slice(-6)}`;

    const profile = expertService.registerExpert(userId!, name);

    return {
      success: true,
      message: `✅ **注册成功**\n\n${formatProfile(profile)}`,
    };
  }

  private handleProfile(context: CommandContext): CommandResult {
    const { userId } = context;
    const expertService = getExpertService();

    const profile = expertService.getExpert(userId!);

    if (!profile) {
      return {
        success: false,
        error: '❌ 您尚未注册为专家\n\n使用 `/expert register [名字]` 注册',
      };
    }

    return {
      success: true,
      message: formatProfile(profile),
    };
  }

  private handleSkills(context: CommandContext): CommandResult {
    const { args, userId } = context;
    const expertService = getExpertService();

    // Check if user is registered
    if (!expertService.isExpert(userId!)) {
      return {
        success: false,
        error: '❌ 您尚未注册为专家\n\n使用 `/expert register [名字]` 注册',
      };
    }

    const action = args[1]?.toLowerCase();

    switch (action) {
      case 'add': {
        const [, , skillName, levelStr] = args;
        const tags = args.slice(4);

        if (!skillName) {
          return { success: false, error: '❌ 请指定技能名称\n\n用法: /expert skills add <技能> <等级1-5> [标签...]' };
        }

        const level = parseSkillLevel(levelStr || '3');
        if (!level) {
          return { success: false, error: '❌ 等级必须是 1-5 的数字\n\n用法: /expert skills add <技能> <等级1-5> [标签...]' };
        }

        const profile = expertService.addSkill(userId!, {
          name: skillName,
          level,
          tags: tags.length > 0 ? tags : undefined,
        });

        return {
          success: true,
          message: `✅ **技能已添加**\n\n${formatProfile(profile)}`,
        };
      }

      case 'remove': {
        const [, , skillName] = args;

        if (!skillName) {
          return { success: false, error: '❌ 请指定要移除的技能名称\n\n用法: /expert skills remove <技能>' };
        }

        const profile = expertService.removeSkill(userId!, skillName);

        if (!profile) {
          return { success: false, error: `❌ 技能 "${skillName}" 不存在` };
        }

        return {
          success: true,
          message: `✅ **技能已移除**\n\n${formatProfile(profile)}`,
        };
      }

      default:
        return {
          success: false,
          error: `❌ 未知技能操作: ${action || '(未指定)'}\n\n用法:\n- /expert skills add <技能> <等级1-5> [标签...]\n- /expert skills remove <技能>`,
        };
    }
  }

  private handleAvailability(context: CommandContext): CommandResult {
    const { args, userId } = context;
    const expertService = getExpertService();

    // Check if user is registered
    if (!expertService.isExpert(userId!)) {
      return {
        success: false,
        error: '❌ 您尚未注册为专家\n\n使用 `/expert register [名字]` 注册',
      };
    }

    const availability = args.slice(1).join(' ');

    if (!availability) {
      return { success: false, error: '❌ 请指定可用时间\n\n用法: /expert availability <时间>\n\n示例: /expert availability 工作日 10:00-18:00' };
    }

    const profile = expertService.setAvailability(userId!, availability);

    return {
      success: true,
      message: `✅ **可用时间已设置**\n\n${formatProfile(profile)}`,
    };
  }

  private handleSearch(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    const [, query, minLevelStr] = args;

    if (!query) {
      return { success: false, error: '❌ 请指定搜索关键词\n\n用法: /expert search <技能> [最低等级]' };
    }

    const minLevel = minLevelStr ? parseSkillLevel(minLevelStr) : undefined;
    const experts = expertService.searchBySkill(query, minLevel);

    if (experts.length === 0) {
      return {
        success: true,
        message: `🔍 未找到匹配 "${query}" 的专家`,
      };
    }

    const lines: string[] = [
      `🔍 **找到 ${experts.length} 位专家**`,
      '',
    ];

    for (const expert of experts) {
      const matchingSkills = expert.skills.filter((s: SkillDeclaration) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        (s.tags?.some((t: string) => t.toLowerCase().includes(query.toLowerCase())) ?? false)
      );

      lines.push(`👤 **${expert.name}**`);
      for (const skill of matchingSkills) {
        const stars = '⭐'.repeat(skill.level);
        lines.push(`   ${skill.name} ${stars}`);
      }
      lines.push('');
    }

    return {
      success: true,
      message: lines.join('\n').trim(),
    };
  }

  private handleList(_context: CommandContext): CommandResult {
    const expertService = getExpertService();
    const experts = expertService.listExperts();

    if (experts.length === 0) {
      return {
        success: true,
        message: '📋 暂无注册专家',
      };
    }

    const lines: string[] = [
      `📋 **注册专家列表** (${experts.length} 位)`,
      '',
    ];

    for (const expert of experts) {
      const skillCount = expert.skills.length;
      const availability = expert.availability ? ` ⏰ ${expert.availability}` : '';
      lines.push(`- **${expert.name}** (${skillCount} 项技能)${availability}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
    };
  }
}

/**
 * Expert Commands - Human expert registration and skill management.
 *
 * Provides commands for:
 * - /expert register - Register as an expert
 * - /expert profile - View expert profile
 * - /expert skills add - Add a skill
 * - /expert skills remove - Remove a skill
 * - /expert availability - Set availability
 * - /expert price - Set consultation price
 * - /expert search - Search experts by skill
 * - /expert list - List all experts
 *
 * @see Issue #535 - 人类专家注册与技能声明
 * @see Issue #536 - 专家查询与匹配
 * @see Issue #538 - 积分系统 - 身价与消费
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

  // Show price if set (Issue #538)
  if (profile.price !== undefined && profile.price > 0) {
    lines.push(`   💰 身价: ${profile.price} 积分/次咨询`);
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
  readonly usage = 'expert <register|profile|skills|availability|price|search|list>';

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
      case 'price':
        return this.handlePrice(context);
      case 'search':
        return this.handleSearch(context);
      case 'list':
        return this.handleList(context);
      default:
        return {
          success: false,
          error: `❌ 未知子命令: ${subCommand || '(未指定)'}\n\n用法:\n- /expert register [名字] - 注册为专家\n- /expert profile - 查看档案\n- /expert skills add <技能> <等级1-5> [标签...]\n- /expert skills remove <技能>\n- /expert availability <时间>\n- /expert price <积分> - 设置每次咨询的积分\n- /expert search <技能> [最低等级] [--available|-a]\n- /expert list - 列出所有专家`,
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

  private handlePrice(context: CommandContext): CommandResult {
    const { args, userId } = context;
    const expertService = getExpertService();

    // Check if user is registered
    if (!expertService.isExpert(userId!)) {
      return {
        success: false,
        error: '❌ 您尚未注册为专家\n\n使用 `/expert register [名字]` 注册',
      };
    }

    const [, priceStr] = args;

    if (!priceStr) {
      // Show current price
      const profile = expertService.getExpert(userId!);
      const currentPrice = profile?.price ?? 0;
      return {
        success: true,
        message: `💰 **当前身价**: ${currentPrice} 积分/次咨询\n\n使用 \`/expert price <积分>\` 设置新身价`,
      };
    }

    const price = parseInt(priceStr, 10);
    if (isNaN(price) || price < 0) {
      return { success: false, error: '❌ 身价必须是非负整数\n\n用法: /expert price <积分>' };
    }

    const profile = expertService.setPrice(userId!, price);

    return {
      success: true,
      message: `✅ **身价已设置**\n\n💰 每次咨询: ${price} 积分\n\n${formatProfile(profile)}`,
    };
  }

  private handleSearch(context: CommandContext): CommandResult {
    const { args } = context;
    const expertService = getExpertService();

    // Check for --available flag
    const hasAvailableFlag = args.includes('--available') || args.includes('-a');
    const filteredArgs = args.filter(arg => arg !== '--available' && arg !== '-a');

    // Get query and minLevel from filtered args
    const actualQuery = filteredArgs[1];
    const actualMinLevelStr = filteredArgs[2];

    if (!actualQuery) {
      return {
        success: false,
        error: '❌ 请指定搜索关键词\n\n用法: /expert search <技能> [最低等级] [--available|-a]\n\n选项:\n  --available, -a  只显示当前可用的专家',
      };
    }

    const minLevel = actualMinLevelStr ? parseSkillLevel(actualMinLevelStr) : undefined;
    const experts = expertService.searchBySkill(actualQuery, minLevel, { available: hasAvailableFlag });

    if (experts.length === 0) {
      const filterDesc = hasAvailableFlag ? ' (仅显示可用)' : '';
      return {
        success: true,
        message: `🔍 未找到匹配 "${actualQuery}" 的专家${filterDesc}`,
      };
    }

    const lines: string[] = [
      `🔍 **找到 ${experts.length} 位专家**${hasAvailableFlag ? ' (仅显示可用)' : ''}`,
      '',
    ];

    for (const expert of experts) {
      const matchingSkills = expert.skills.filter((s: SkillDeclaration) =>
        s.name.toLowerCase().includes(actualQuery.toLowerCase()) ||
        (s.tags?.some((t: string) => t.toLowerCase().includes(actualQuery.toLowerCase())) ?? false)
      );

      const availabilityStatus = expertService.isExpertAvailable(expert.userId) ? '🟢' : '🔴';
      lines.push(`👤 **${expert.name}** ${availabilityStatus}`);
      for (const skill of matchingSkills) {
        const stars = '⭐'.repeat(skill.level);
        lines.push(`   ${skill.name} ${stars}`);
      }
      if (expert.availability) {
        lines.push(`   ⏰ ${expert.availability}`);
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

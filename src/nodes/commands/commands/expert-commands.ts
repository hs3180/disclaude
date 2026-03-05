/**
 * Expert Commands - Human expert registration and skill management.
 *
 * Provides commands for registering as an expert and declaring skills.
 *
 * @see Issue #535 - 人类专家注册与技能声明
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import type { SkillLevel, ExpertProfile, Skill } from '../../../experts/types.js';

/**
 * Parse skill level from string (1-5).
 */
function parseSkillLevel(levelStr: string): SkillLevel | null {
  const level = parseInt(levelStr, 10);
  if (level >= 1 && level <= 5) {
    return level as SkillLevel;
  }
  return null;
}

/**
 * Format expert profile for display.
 */
function formatProfile(profile: ExpertProfile): string {
  const lines: string[] = [
    `📋 **专家档案**`,
    ``,
    `👤 用户 ID: \`${profile.userId}\``,
    `📅 注册时间: ${new Date(profile.registeredAt).toLocaleString('zh-CN')}`,
    `🔄 更新时间: ${new Date(profile.updatedAt).toLocaleString('zh-CN')}`,
  ];

  // Skills
  if (profile.skills.length > 0) {
    lines.push(``, `🎯 **技能** (${profile.skills.length}):`);
    for (const skill of profile.skills) {
      const stars = '⭐'.repeat(skill.level);
      const tags = skill.tags.length > 0 ? ` [${skill.tags.join(', ')}]` : '';
      lines.push(`  • ${skill.name} - ${stars} (Lv.${skill.level})${tags}`);
    }
  } else {
    lines.push(``, `🎯 **技能**: 暂无`);
  }

  // Availability
  if (profile.availability) {
    lines.push(``, `⏰ **可用时间**: ${profile.availability.days} ${profile.availability.timeRange}`);
  }

  return lines.join('\n');
}

/**
 * Expert Register Command - Register as an expert.
 */
export class ExpertRegisterCommand implements Command {
  readonly name = 'expert-register';
  readonly category = 'expert' as const;
  readonly description = '注册为专家';
  readonly usage = 'expert-register';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, userId } = context;

    if (!userId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    const profile = services.registerExpert(userId);

    if (profile.registeredAt === profile.updatedAt) {
      return {
        success: true,
        message: `✅ **注册成功**\n\n您已成功注册为专家！\n\n使用以下命令添加技能:\n• \`/expert-skill-add <技能名> <等级1-5> [标签...]\`\n\n使用以下命令设置可用时间:\n• \`/expert-availability <日期模式> <时间范围>\``,
      };
    } else {
      return {
        success: true,
        message: `您已经是注册专家了。\n\n${formatProfile(profile)}`,
      };
    }
  }
}

/**
 * Expert Profile Command - View expert profile.
 */
export class ExpertProfileCommand implements Command {
  readonly name = 'expert-profile';
  readonly category = 'expert' as const;
  readonly description = '查看专家档案';
  readonly usage = 'expert-profile [用户ID]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    // Use provided userId or current user
    const targetUserId = args.length > 0 ? args[0] : userId;

    if (!targetUserId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    const profile = services.getExpertProfile(targetUserId);

    if (!profile) {
      if (args.length > 0) {
        return { success: false, error: `用户 \`${targetUserId}\` 尚未注册为专家` };
      }
      return {
        success: false,
        error: '您尚未注册为专家。使用 `/expert-register` 注册。',
      };
    }

    return {
      success: true,
      message: formatProfile(profile),
    };
  }
}

/**
 * Expert Skill Add Command - Add a skill to profile.
 */
export class ExpertSkillAddCommand implements Command {
  readonly name = 'expert-skill-add';
  readonly category = 'expert' as const;
  readonly description = '添加技能';
  readonly usage = 'expert-skill-add <技能名> <等级1-5> [标签...]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    if (!userId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/expert-skill-add <技能名> <等级1-5> [标签...]\`\n\n示例:\n• `/expert-skill-add React 4 frontend web`\n• `/expert-skill-add Node.js 3 backend api`',
      };
    }

    const skillName = args[0];
    const level = parseSkillLevel(args[1]);

    if (!level) {
      return { success: false, error: '技能等级必须是 1-5 之间的数字' };
    }

    const tags = args.slice(2);

    const profile = services.addExpertSkill({
      userId,
      name: skillName,
      level,
      tags,
    });

    if (!profile) {
      return {
        success: false,
        error: '您尚未注册为专家。使用 `/expert-register` 注册。',
      };
    }

    return {
      success: true,
      message: `✅ **技能添加成功**\n\n技能: ${skillName}\n等级: ${'⭐'.repeat(level)} (Lv.${level})${tags.length > 0 ? `\n标签: ${tags.join(', ')}` : ''}`,
    };
  }
}

/**
 * Expert Skill Remove Command - Remove a skill from profile.
 */
export class ExpertSkillRemoveCommand implements Command {
  readonly name = 'expert-skill-remove';
  readonly category = 'expert' as const;
  readonly description = '移除技能';
  readonly usage = 'expert-skill-remove <技能名>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    if (!userId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/expert-skill-remove <技能名>`\n\n示例: `/expert-skill-remove React`',
      };
    }

    const skillName = args[0];

    const profile = services.removeExpertSkill({
      userId,
      name: skillName,
    });

    if (!profile) {
      return {
        success: false,
        error: '您尚未注册为专家。使用 `/expert-register` 注册。',
      };
    }

    return {
      success: true,
      message: `✅ **技能移除成功**\n\n技能: ${skillName}`,
    };
  }
}

/**
 * Expert Availability Command - Set availability schedule.
 */
export class ExpertAvailabilityCommand implements Command {
  readonly name = 'expert-availability';
  readonly category = 'expert' as const;
  readonly description = '设置可用时间';
  readonly usage = 'expert-availability <日期模式> <时间范围>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    if (!userId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/expert-availability <日期模式> <时间范围>`\n\n示例:\n• `/expert-availability weekdays 10:00-18:00`\n• `/expert-availability weekends 14:00-20:00`\n• `/expert-availability all 09:00-22:00`',
      };
    }

    const days = args[0];
    const timeRange = args[1];

    // Validate time range format
    if (!/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(timeRange)) {
      return {
        success: false,
        error: '时间范围格式无效，请使用 HH:MM-HH:MM 格式\n\n示例: 10:00-18:00',
      };
    }

    const profile = services.setExpertAvailability({
      userId,
      days,
      timeRange,
    });

    if (!profile) {
      return {
        success: false,
        error: '您尚未注册为专家。使用 `/expert-register` 注册。',
      };
    }

    return {
      success: true,
      message: `✅ **可用时间设置成功**\n\n日期模式: ${days}\n时间范围: ${timeRange}`,
    };
  }
}

/**
 * Expert List Command - List all experts.
 */
export class ExpertListCommand implements Command {
  readonly name = 'expert-list';
  readonly category = 'expert' as const;
  readonly description = '列出所有专家';
  readonly usage = 'expert-list [技能名]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    let experts: ExpertProfile[];

    if (args.length > 0) {
      const skillName = args[0];
      experts = services.findExpertsBySkill(skillName);
      if (experts.length === 0) {
        return {
          success: true,
          message: `📋 **专家搜索结果**\n\n没有找到拥有技能 "${skillName}" 的专家`,
        };
      }

      const lines: string[] = [
        `📋 **专家搜索结果** (技能: ${skillName})`,
        ``,
        `找到 ${experts.length} 位专家:`,
      ];

      for (const expert of experts) {
        const matchingSkills = expert.skills.filter(
          (s: Skill) => s.name.toLowerCase().includes(skillName.toLowerCase())
        );
        const skillList = matchingSkills
          .map((s: Skill) => `${s.name} (Lv.${s.level})`)
          .join(', ');
        lines.push(`• \`${expert.userId}\` - ${skillList}`);
      }

      return { success: true, message: lines.join('\n') };
    }

    experts = services.listExperts();

    if (experts.length === 0) {
      return { success: true, message: '📋 **专家列表**\n\n暂无注册专家' };
    }

    const lines: string[] = [
      `📋 **专家列表** (共 ${experts.length} 位)`,
      ``,
    ];

    for (const expert of experts) {
      const skillCount = expert.skills.length;
      const availability = expert.availability
        ? ` | ${expert.availability.days} ${expert.availability.timeRange}`
        : '';
      lines.push(`• \`${expert.userId}\` - ${skillCount} 项技能${availability}`);
    }

    return { success: true, message: lines.join('\n') };
  }
}

/**
 * Expert Unregister Command - Unregister as an expert.
 */
export class ExpertUnregisterCommand implements Command {
  readonly name = 'expert-unregister';
  readonly category = 'expert' as const;
  readonly description = '注销专家身份';
  readonly usage = 'expert-unregister';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, userId } = context;

    if (!userId) {
      return { success: false, error: '无法获取用户 ID' };
    }

    const removed = services.unregisterExpert(userId);

    if (!removed) {
      return {
        success: false,
        error: '您尚未注册为专家',
      };
    }

    return {
      success: true,
      message: `✅ **注销成功**\n\n您已成功注销专家身份`,
    };
  }
}

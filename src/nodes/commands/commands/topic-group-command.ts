/**
 * Topic Group Command - Manage topic groups (BBS mode).
 *
 * Issue #721: 话题群基础设施 - BBS 模式支持
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Topic Group Command - Manage topic groups for BBS-style discussions.
 *
 * This is useful for BBS-style discussions like daily questions or topic posts.
 */
export class TopicGroupCommand implements Command {
  readonly name = 'topic-group';
  readonly category = 'group' as const;
  readonly description = '话题群管理';
  readonly usage = 'topic-group <mark|unmark|list|status> [chatId]';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const subCommand = context.args[0]?.toLowerCase() || 'status';

    // Validate subcommand
    const validSubcommands = ['mark', 'unmark', 'list', 'status'];
    if (!validSubcommands.includes(subCommand)) {
      return {
        success: false,
        error: `未知的子命令: \`${subCommand}\`\n\n可用子命令: ${validSubcommands.map(c => `\`${c}\``).join(', ')}`,
      };
    }

    // Handle list subcommand - list all topic groups
    if (subCommand === 'list') {
      return this.handleList(services);
    }

    // Handle status subcommand - show current group status
    if (subCommand === 'status') {
      return this.handleStatus(services, chatId);
    }

    // mark/unmark require a target chatId
    const targetChatId = context.args[1] || chatId;

    if (subCommand === 'mark') {
      return this.handleMark(services, targetChatId);
    }

    if (subCommand === 'unmark') {
      return this.handleUnmark(services, targetChatId);
    }

    return { success: false, error: '未知子命令' };
  }

  private handleList(services: CommandContext['services']): CommandResult {
    const topicGroups = services.listTopicGroups();

    if (topicGroups.length === 0) {
      return {
        success: true,
        message: '📋 **话题群列表**\n\n暂无话题群\n\n使用 `/topic-group mark [chatId]` 将群标记为话题群',
      };
    }

    const groupList = topicGroups.map(g => {
      const createdAt = new Date(g.createdAt).toLocaleDateString('zh-CN');
      return `- **${g.name}** \`${g.chatId}\` (创建于 ${createdAt})`;
    }).join('\n');

    return {
      success: true,
      message: `📋 **话题群列表** (共 ${topicGroups.length} 个)\n\n${groupList}`,
    };
  }

  private handleStatus(services: CommandContext['services'], chatId: string): CommandResult {
    const isTopic = services.isTopicGroup(chatId);
    const allGroups = services.listGroups();
    const currentGroup = allGroups.find(g => g.chatId === chatId);

    if (!currentGroup) {
      return {
        success: true,
        message: `📋 **话题群状态**\n\n当前群 \`${chatId}\` 不在托管列表中\n\n使用 \`/topic-group mark\` 将当前群标记为话题群`,
      };
    }

    const statusText = isTopic ? '✅ 是话题群' : '❌ 不是话题群';
    return {
      success: true,
      message: `📋 **话题群状态**\n\n群名称: **${currentGroup.name}**\n群 ID: \`${chatId}\`\n状态: ${statusText}\n\n话题群特点:\n- 支持 Agent 主动推送消息\n- 不预期用户响应（BBS 模式）`,
    };
  }

  private handleMark(services: CommandContext['services'], chatId: string): CommandResult {
    const success = services.markAsTopicGroup(chatId, true);

    if (!success) {
      return {
        success: false,
        error: `标记失败: 群 \`${chatId}\` 不在托管列表中\n\n请先使用 \`/create-group\` 创建群或确保群已被管理`,
      };
    }

    return {
      success: true,
      message: `✅ **话题群已标记**\n\n群 \`${chatId}\` 已标记为话题群\n\n话题群特点:\n- 支持 Agent 主动推送消息\n- 不预期用户响应（BBS 模式）`,
    };
  }

  private handleUnmark(services: CommandContext['services'], chatId: string): CommandResult {
    const success = services.markAsTopicGroup(chatId, false);

    if (!success) {
      return {
        success: false,
        error: `取消标记失败: 群 \`${chatId}\` 不在托管列表中`,
      };
    }

    return {
      success: true,
      message: `✅ **话题群标记已取消**\n\n群 \`${chatId}\` 已不再是话题群`,
    };
  }
}

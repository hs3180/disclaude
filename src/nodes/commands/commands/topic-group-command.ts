/**
 * Topic Group Command - Manage topic groups (BBS mode).
 *
 * Issue #721: 话题群基础设施 - BBS 模式支持
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #873: 话题群扩展 - 群管理操作与发帖跟帖接口
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
  readonly usage = 'topic-group <mark|unmark|list|status|batch-mark|batch-unmark> [chatId...]';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const subCommand = context.args[0]?.toLowerCase() || 'status';

    // Validate subcommand
    const validSubcommands = ['mark', 'unmark', 'list', 'status', 'batch-mark', 'batch-unmark', 'members', 'add-members', 'remove-members'];
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

    // Handle batch-mark subcommand - mark multiple groups as topic groups
    if (subCommand === 'batch-mark') {
      const chatIds = context.args.slice(1);
      return this.handleBatchMark(services, chatIds);
    }

    // Handle batch-unmark subcommand - unmark multiple groups
    if (subCommand === 'batch-unmark') {
      const chatIds = context.args.slice(1);
      return this.handleBatchUnmark(services, chatIds);
    }

    // Handle members subcommand - list members of a topic group
    if (subCommand === 'members') {
      const targetChatId = context.args[1] || chatId;
      return this.handleMembers(services, targetChatId);
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

  /**
   * Batch mark multiple groups as topic groups.
   *
   * Issue #873: 话题群扩展 - 批量管理话题群
   */
  private handleBatchMark(services: CommandContext['services'], chatIds: string[]): CommandResult {
    if (chatIds.length === 0) {
      return {
        success: false,
        error: '请提供要标记的群 ID 列表\n\n用法: `/topic-group batch-mark chatId1 chatId2 ...`',
      };
    }

    const results: { chatId: string; success: boolean; error?: string }[] = [];
    let successCount = 0;

    for (const targetChatId of chatIds) {
      const success = services.markAsTopicGroup(targetChatId, true);
      if (success) {
        successCount++;
        results.push({ chatId: targetChatId, success: true });
      } else {
        results.push({ chatId: targetChatId, success: false, error: '群不在托管列表中' });
      }
    }

    const successList = results.filter(r => r.success).map(r => `- ✅ \`${r.chatId}\``).join('\n');
    const failList = results.filter(r => !r.success).map(r => `- ❌ \`${r.chatId}\`: ${r.error}`).join('\n');

    let message = `📋 **批量标记话题群**\n\n成功: ${successCount}/${chatIds.length}\n\n`;
    if (successList) message += `**成功**:\n${successList}\n\n`;
    if (failList) message += `**失败**:\n${failList}`;

    return { success: successCount > 0, message };
  }

  /**
   * Batch unmark multiple topic groups.
   *
   * Issue #873: 话题群扩展 - 批量管理话题群
   */
  private handleBatchUnmark(services: CommandContext['services'], chatIds: string[]): CommandResult {
    if (chatIds.length === 0) {
      return {
        success: false,
        error: '请提供要取消标记的群 ID 列表\n\n用法: `/topic-group batch-unmark chatId1 chatId2 ...`',
      };
    }

    const results: { chatId: string; success: boolean; error?: string }[] = [];
    let successCount = 0;

    for (const targetChatId of chatIds) {
      const success = services.markAsTopicGroup(targetChatId, false);
      if (success) {
        successCount++;
        results.push({ chatId: targetChatId, success: true });
      } else {
        results.push({ chatId: targetChatId, success: false, error: '群不在托管列表中' });
      }
    }

    const successList = results.filter(r => r.success).map(r => `- ✅ \`${r.chatId}\``).join('\n');
    const failList = results.filter(r => !r.success).map(r => `- ❌ \`${r.chatId}\`: ${r.error}`).join('\n');

    let message = `📋 **批量取消话题群标记**\n\n成功: ${successCount}/${chatIds.length}\n\n`;
    if (successList) message += `**成功**:\n${successList}\n\n`;
    if (failList) message += `**失败**:\n${failList}`;

    return { success: successCount > 0, message };
  }

  /**
   * List members of a topic group.
   * Note: This is a placeholder - actual member management requires Feishu API calls.
   *
   * Issue #873: 话题群扩展 - 话题群成员管理
   */
  private handleMembers(services: CommandContext['services'], chatId: string): CommandResult {
    const allGroups = services.listGroups();
    const group = allGroups.find(g => g.chatId === chatId);

    if (!group) {
      return {
        success: false,
        error: `群 \`${chatId}\` 不在托管列表中`,
      };
    }

    const memberList = group.initialMembers.length > 0
      ? group.initialMembers.map(m => `- \`${m}\``).join('\n')
      : '(无记录)';

    return {
      success: true,
      message: `📋 **话题群成员**\n\n群名称: **${group.name}**\n群 ID: \`${chatId}\`\n\n初始成员:\n${memberList}\n\n> 注: 完整成员管理需要通过飞书客户端或 API 操作`,
    };
  }
}

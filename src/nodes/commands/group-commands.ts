/**
 * Group Commands - Group chat management.
 *
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * Create Group Command - Create a new group chat.
 *
 * Issue #599: 简化建群指令
 * - 无需 members 列表（自动拉入发起者）
 * - 群名可选（自动生成）
 */
export class CreateGroupCommand implements Command {
  readonly name = 'create-group';
  readonly category = 'group' as const;
  readonly description = '创建群';
  readonly usage = 'create-group [name]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args, userId } = context;

    // Parse arguments: name is optional
    const name = args.length > 0 ? args.join(' ') : undefined;

    // Parse members if provided (format: --members ou_xxx,ou_yyy)
    let members: string[] | undefined;
    const membersIndex = args.findIndex(arg => arg === '--members');
    if (membersIndex !== -1 && args[membersIndex + 1]) {
      members = args[membersIndex + 1].split(',').map(m => m.trim()).filter(m => m);
    }

    try {
      const client = services.getFeishuClient();
      // Pass creatorId to auto-add creator if no members specified
      const chatId = await services.createDiscussionChat(
        client,
        { topic: name, members },
        userId
      );

      // Determine actual members for registration
      const actualMembers = members && members.length > 0 ? members : (userId ? [userId] : []);

      // Register the group
      services.registerGroup({
        chatId,
        name: name || '自动命名',  // Will be updated by createDiscussionChat
        createdAt: Date.now(),
        createdBy: userId,
        initialMembers: actualMembers,
      });

      return {
        success: true,
        message: `✅ **群创建成功**\n\n群 ID: \`${chatId}\`\n${name ? `群名称: ${name}\n` : ''}成员数: ${actualMembers.length}`,
      };
    } catch (error) {
      return { success: false, error: `创建群失败: ${(error as Error).message}` };
    }
  }
}

/**
 * Add Group Member Command - Add a member to a group.
 */
export class AddGroupMemberCommand implements Command {
  readonly name = 'add-group-member';
  readonly category = 'group' as const;
  readonly description = '添加群成员';
  readonly usage = 'add-group-member <groupId> <member>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/add-group-member <群ID> <成员ID>`\n\n示例: `/add-group-member oc_xxx ou_yyy`',
      };
    }

    const [groupId, memberId] = args;

    try {
      const client = services.getFeishuClient();
      await services.addMembers(client, groupId, [memberId]);
      return { success: true, message: `✅ **成员添加成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
    } catch (error) {
      return { success: false, error: `添加成员失败: ${(error as Error).message}` };
    }
  }
}

/**
 * Remove Group Member Command - Remove a member from a group.
 */
export class RemoveGroupMemberCommand implements Command {
  readonly name = 'remove-group-member';
  readonly category = 'group' as const;
  readonly description = '移除群成员';
  readonly usage = 'remove-group-member <groupId> <member>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 2) {
      return {
        success: false,
        error: '用法: `/remove-group-member <群ID> <成员ID>`\n\n示例: `/remove-group-member oc_xxx ou_yyy`',
      };
    }

    const [groupId, memberId] = args;

    try {
      const client = services.getFeishuClient();
      await services.removeMembers(client, groupId, [memberId]);
      return { success: true, message: `✅ **成员移除成功**\n\n群 ID: \`${groupId}\`\n成员: \`${memberId}\`` };
    } catch (error) {
      return { success: false, error: `移除成员失败: ${(error as Error).message}` };
    }
  }
}

/**
 * List Group Members Command - List members of a group.
 */
export class ListGroupMembersCommand implements Command {
  readonly name = 'list-group-members';
  readonly category = 'group' as const;
  readonly description = '列出群成员';
  readonly usage = 'list-group-members <groupId>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/list-group-members <群ID>`\n\n示例: `/list-group-members oc_xxx`',
      };
    }

    const [groupId] = args;

    try {
      const client = services.getFeishuClient();
      const members = await services.getMembers(client, groupId);

      if (members.length === 0) {
        return { success: true, message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: 0` };
      }

      const memberList = members.map(m => `- \`${m}\``).join('\n');
      return {
        success: true,
        message: `📋 **群成员列表**\n\n群 ID: \`${groupId}\`\n成员数: ${members.length}\n\n${memberList}`,
      };
    } catch (error) {
      return { success: false, error: `获取成员列表失败: ${(error as Error).message}` };
    }
  }
}

/**
 * List Group Command - List all groups the bot is in.
 * Issue #648: 改进群列表命令 - 更名 + API获取 + 分类展示
 */
export class ListGroupCommand implements Command {
  readonly name = 'groups';
  readonly category = 'group' as const;
  readonly description = '列出群';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services } = context;

    try {
      const client = services.getFeishuClient();

      // Get all chats from Feishu API
      const allChats = await services.getBotChats(client);

      // Get managed groups from local registry
      const managedGroups = services.listGroups();
      const managedChatIds = new Set(managedGroups.map(g => g.chatId));

      // Categorize chats
      const botCreatedGroups = allChats.filter(c => managedChatIds.has(c.chatId));
      const invitedGroups = allChats.filter(c => !managedChatIds.has(c.chatId));

      // Build output
      if (allChats.length === 0) {
        return { success: true, message: '📋 **群列表**\n\n暂无群聊' };
      }

      const lines: string[] = [`📋 **群列表** (共 ${allChats.length} 个)\n`];

      // Bot created groups
      if (botCreatedGroups.length > 0) {
        lines.push(`🤖 **机器人创建的群** (${botCreatedGroups.length})`);
        for (const g of botCreatedGroups) {
          lines.push(`• ${g.name} - \`${g.chatId}\``);
        }
        lines.push('');
      }

      // Invited groups
      if (invitedGroups.length > 0) {
        lines.push(`👥 **被邀请加入的群** (${invitedGroups.length})`);
        for (const g of invitedGroups) {
          lines.push(`• ${g.name} - \`${g.chatId}\``);
        }
      }

      return {
        success: true,
        message: lines.join('\n'),
      };
    } catch (error) {
      return { success: false, error: `获取群列表失败: ${(error as Error).message}` };
    }
  }
}

/**
 * Dissolve Group Command - Dissolve a group.
 */
export class DissolveGroupCommand implements Command {
  readonly name = 'dissolve-group';
  readonly category = 'group' as const;
  readonly description = '解散群';
  readonly usage = 'dissolve-group <groupId>';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, args } = context;

    if (args.length < 1) {
      return {
        success: false,
        error: '用法: `/dissolve-group <群ID>`\n\n示例: `/dissolve-group oc_xxx`',
      };
    }

    const [groupId] = args;

    try {
      const client = services.getFeishuClient();
      await services.dissolveChat(client, groupId);

      // Unregister the group
      const wasManaged = services.unregisterGroup(groupId);

      return {
        success: true,
        message: `✅ **群解散成功**\n\n群 ID: \`${groupId}\`${wasManaged ? '' : ' (非托管群)'}`,
      };
    } catch (error) {
      return { success: false, error: `解散群失败: ${(error as Error).message}` };
    }
  }
}

/**
 * Passive Command - Control passive mode for group chats.
 * Issue #511: Group chat passive mode control
 * Issue #601: Fix passive command not returning status
 */
export class PassiveCommand implements Command {
  readonly name = 'passive';
  readonly category = 'group' as const;
  readonly description = '群聊被动模式开关';
  readonly usage = 'passive [on|off|status]';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    // Default to status if no args
    const subCommand = context.args[0]?.toLowerCase() || 'status';

    // Validate subcommand
    if (!['on', 'off', 'status'].includes(subCommand)) {
      return {
        success: false,
        error: '用法: `/passive [on|off|status]`\n\n- `on` - 开启被动模式（仅响应 @提及）\n- `off` - 关闭被动模式（响应所有消息）\n- `status` - 查看当前状态',
      };
    }

    // Handle subcommands directly (Issue #601: fix missing status response)
    if (subCommand === 'status') {
      const isDisabled = services.getPassiveMode(chatId);
      const statusText = isDisabled ? '关闭（响应所有消息）' : '开启（仅响应 @提及）';
      return {
        success: true,
        message: `📋 **被动模式状态**\n\n当前状态: ${statusText}\n\n- 开启时，仅响应 @提及的消息\n- 关闭时，响应所有消息`,
      };
    }

    if (subCommand === 'on') {
      services.setPassiveMode(chatId, false); // false = passive mode enabled = only @mention
      return {
        success: true,
        message: '✅ **被动模式已开启**\n\nBot 将仅响应 @提及的消息',
      };
    }

    if (subCommand === 'off') {
      services.setPassiveMode(chatId, true); // true = passive mode disabled = respond to all
      return {
        success: true,
        message: '✅ **被动模式已关闭**\n\nBot 将响应所有消息',
      };
    }

    // This should never be reached due to validation above
    return { success: false, error: '未知子命令' };
  }
}

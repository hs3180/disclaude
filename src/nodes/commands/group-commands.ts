/**
 * Group Commands - Group chat management commands.
 *
 * Commands for creating, managing, and dissolving group chats.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 * Issue #599: 简化建群指令
 * Issue #648: 改进群列表命令
 * Issue #692: 重构为使用 GroupService.createGroup()
 * Issue #696: 拆分 builtin-commands.ts
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * Create Group Command - Create a new group chat.
 *
 * Issue #599: 简化建群指令
 * - 无需 members 列表（自动拉入发起者）
 * - 群名可选（自动生成）
 *
 * Issue #692: 重构为使用 GroupService.createGroup()
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
      // Use GroupService.createGroup() for unified group creation (Issue #692)
      const groupInfo = await services.createGroup(client, {
        topic: name,
        members,
        creatorId: userId,
      });

      return {
        success: true,
        message: `✅ **群创建成功**\n\n群 ID: \`${groupInfo.chatId}\`\n${name ? `群名称: ${name}\n` : ''}成员数: ${groupInfo.initialMembers.length}`,
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

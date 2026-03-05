/**
 * Passive Command - Control passive mode for group chats.
 *
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #511: Group chat passive mode control
 * Issue #601: Fix passive command not returning status
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

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

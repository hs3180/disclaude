/**
 * Debug Commands - Debug group management.
 *
 * Provides commands for setting, viewing, and clearing debug groups.
 *
 * Issue #696: 拆分 builtin-commands.ts
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #537: 完成所有指令的 DI 重构
 */

import type { Command, CommandContext, CommandResult } from '../types.js';

/**
 * Set Debug Command - Set the debug group.
 */
export class SetDebugCommand implements Command {
  readonly name = 'set-debug';
  readonly category = 'debug' as const;
  readonly description = '设置调试群';

  execute(context: CommandContext): CommandResult {
    const { services, chatId } = context;
    const previous = services.setDebugGroup(chatId);

    if (previous) {
      return {
        success: true,
        message: `✅ **调试群已转移**\n\n从 \`${previous.chatId}\` 转移至此群 (\`${chatId}\`)`,
      };
    }

    return {
      success: true,
      message: `✅ **调试群已设置**\n\n此群 (\`${chatId}\`) 已设为调试群`,
    };
  }
}

/**
 * Show Debug Command - Show the current debug group.
 */
export class ShowDebugCommand implements Command {
  readonly name = 'show-debug';
  readonly category = 'debug' as const;
  readonly description = '查看调试群';

  execute(context: CommandContext): CommandResult {
    const current = context.services.getDebugGroup();

    if (!current) {
      return {
        success: true,
        message: '📋 **调试群状态**\n\n尚未设置调试群\n\n使用 `/set-debug` 设置当前群为调试群',
      };
    }

    const setAt = new Date(current.setAt).toLocaleString('zh-CN');
    return {
      success: true,
      message: `📋 **调试群状态**\n\n群 ID: \`${current.chatId}\`\n设置时间: ${setAt}`,
    };
  }
}

/**
 * Clear Debug Command - Clear the debug group.
 */
export class ClearDebugCommand implements Command {
  readonly name = 'clear-debug';
  readonly category = 'debug' as const;
  readonly description = '清除调试群';

  execute(context: CommandContext): CommandResult {
    const previous = context.services.clearDebugGroup();

    if (!previous) {
      return {
        success: true,
        message: '📋 **调试群状态**\n\n没有设置调试群，无需清除',
      };
    }

    return {
      success: true,
      message: `✅ **调试群已清除**\n\n原调试群: \`${previous.chatId}\``,
    };
  }
}

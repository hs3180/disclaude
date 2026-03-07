/**
 * Thread Commands - Conversation thread management.
 *
 * Provides commands for managing multiple conversation threads per chat.
 *
 * Issue #1072: Thread Management - 支持多对话切换
 *
 * Commands:
 * - /thread save <name>     - Save current conversation as a new thread
 * - /thread list            - List all saved threads
 * - /thread switch <name>   - Switch to a different thread
 * - /thread delete <name>   - Delete a thread
 * - /thread rename <old> <new> - Rename a thread
 */

import type { Command, CommandContext, CommandResult } from '../types.js';
import type { Thread } from '../../../conversation/thread-manager.js';

/**
 * Format a timestamp to a human-readable string.
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Generate thread list display.
 */
function formatThreadList(threads: Thread[], currentThreadId: string | undefined): string {
  if (threads.length === 0) {
    return '📋 **对话线程**\n\n暂无保存的线程。\n\n使用 `/thread save <名称>` 保存当前对话。';
  }

  const lines: string[] = ['📋 **对话线程**', ''];

  for (const thread of threads) {
    const isCurrent = thread.id === currentThreadId;
    const icon = isCurrent ? '📍' : '📁';
    const marker = isCurrent ? ' *当前*' : '';

    lines.push(`${icon} **${thread.name}**${marker}`);
    lines.push(`   创建: ${formatTime(thread.createdAt)}`);
    lines.push(`   消息: ${thread.messageCount}条`);
    if (thread.summary) {
      lines.push(`   摘要: ${thread.summary}`);
    }
    lines.push('');
  }

  lines.push('使用 `/thread switch <名称>` 切换线程');
  return lines.join('\n');
}

/**
 * Thread Command - Manage conversation threads.
 */
export class ThreadCommand implements Command {
  readonly name = 'thread';
  readonly category = 'thread' as const;
  readonly description = '管理对话线程';
  readonly usage = 'thread <save|list|switch|delete|rename> [参数...]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { args } = context;
    const subCommand = args[0]?.toLowerCase();

    try {
      switch (subCommand) {
        case 'save':
          return this.handleSave(context);
        case 'list':
        case 'ls':
          return this.handleList(context);
        case 'switch':
        case 'use':
          return this.handleSwitch(context);
        case 'delete':
        case 'rm':
          return this.handleDelete(context);
        case 'rename':
          return this.handleRename(context);
        case undefined:
        case 'help':
          return this.handleHelp();
        default:
          return {
            success: false,
            error: `未知子命令: ${subCommand}\n\n使用 /thread help 查看帮助`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '操作失败',
      };
    }
  }

  /**
   * Handle /thread save <name>
   */
  private handleSave(context: CommandContext): CommandResult {
    const { args, chatId, services } = context;
    const name = args.slice(1).join(' ').trim();

    if (!name) {
      return {
        success: false,
        error: '请指定线程名称\n\n用法: /thread save <名称>',
      };
    }

    // Get current thread root ID
    const currentThreadRootId = services.getCurrentThreadRootId(chatId);
    if (!currentThreadRootId) {
      return {
        success: false,
        error: '无法保存: 当前没有活跃的对话',
      };
    }

    try {
      const thread = services.saveThread(chatId, name);
      return {
        success: true,
        message: `✅ **线程已保存**\n\n名称: ${thread.name}\nID: ${thread.id}\n\n使用 /thread list 查看所有线程`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '保存失败',
      };
    }
  }

  /**
   * Handle /thread list
   */
  private handleList(context: CommandContext): CommandResult {
    const { chatId, services } = context;
    const threads = services.listThreads(chatId);
    const currentThread = services.getCurrentThread(chatId);

    return {
      success: true,
      message: formatThreadList(threads, currentThread?.id),
    };
  }

  /**
   * Handle /thread switch <name>
   */
  private handleSwitch(context: CommandContext): CommandResult {
    const { args, chatId, services } = context;
    const nameOrId = args.slice(1).join(' ').trim();

    if (!nameOrId) {
      return {
        success: false,
        error: '请指定线程名称或ID\n\n用法: /thread switch <名称>',
      };
    }

    const thread = services.switchThread(chatId, nameOrId);
    if (!thread) {
      return {
        success: false,
        error: `未找到线程: ${nameOrId}\n\n使用 /thread list 查看所有线程`,
      };
    }

    return {
      success: true,
      message: `✅ **已切换到线程**\n\n名称: ${thread.name}\n消息数: ${thread.messageCount}条\n创建: ${formatTime(thread.createdAt)}`,
    };
  }

  /**
   * Handle /thread delete <name>
   */
  private handleDelete(context: CommandContext): CommandResult {
    const { args, chatId, services } = context;
    const nameOrId = args.slice(1).join(' ').trim();

    if (!nameOrId) {
      return {
        success: false,
        error: '请指定线程名称或ID\n\n用法: /thread delete <名称>',
      };
    }

    const deleted = services.deleteThread(chatId, nameOrId);
    if (!deleted) {
      return {
        success: false,
        error: `未找到线程: ${nameOrId}\n\n使用 /thread list 查看所有线程`,
      };
    }

    return {
      success: true,
      message: `✅ **线程已删除**\n\n${nameOrId}`,
    };
  }

  /**
   * Handle /thread rename <old> <new>
   */
  private handleRename(context: CommandContext): CommandResult {
    const { args, chatId, services } = context;
    const oldName = args[1];
    const newName = args.slice(2).join(' ').trim();

    if (!oldName || !newName) {
      return {
        success: false,
        error: '请指定旧名称和新名称\n\n用法: /thread rename <旧名称> <新名称>',
      };
    }

    try {
      const thread = services.renameThread(chatId, oldName, newName);
      if (!thread) {
        return {
          success: false,
          error: `未找到线程: ${oldName}\n\n使用 /thread list 查看所有线程`,
        };
      }

      return {
        success: true,
        message: `✅ **线程已重命名**\n\n${oldName} → ${newName}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '重命名失败',
      };
    }
  }

  /**
   * Handle /thread help
   */
  private handleHelp(): CommandResult {
    return {
      success: true,
      message: `🧵 **线程管理命令**

**用法:**
- \`/thread save <名称>\` - 保存当前对话为新线程
- \`/thread list\` - 列出所有保存的线程
- \`/thread switch <名称>\` - 切换到指定线程
- \`/thread delete <名称>\` - 删除线程
- \`/thread rename <旧名称> <新名称>\` - 重命名线程

**示例:**
\`\`\`
/thread save 财报分析
/thread list
/thread switch 财报分析
/thread rename 财报分析 Q1财报
/thread delete 旧线程
\`\`\`

**功能说明:**
- 每个聊天可以有多个独立的对话线程
- 线程之间上下文隔离
- 重启后线程会自动恢复`,
    };
  }
}

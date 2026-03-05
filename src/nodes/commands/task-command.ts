/**
 * Task Command - Unified task management commands.
 *
 * Issue #468: 任务控制指令 - deep task 执行管理
 * Issue #696: 拆分 builtin-commands.ts
 *
 * Subcommands:
 * - <prompt>: Start a new task with the given prompt
 * - status: View current task status
 * - list: List task history
 * - cancel: Cancel current task
 * - pause: Pause current task
 * - resume: Resume paused task
 */

import type { Command, CommandContext, CommandResult } from './types.js';

/**
 * Task Command - Unified task management commands.
 */
export class TaskCommand implements Command {
  readonly name = 'task';
  readonly category = 'task' as const;
  readonly description = '任务控制指令';
  readonly usage = 'task [<prompt>|status|list|cancel|pause|resume]';

  async execute(context: CommandContext): Promise<CommandResult> {
    const { services, chatId, userId, rawText } = context;
    const subCommand = context.args[0]?.toLowerCase();

    // Status emoji mapping
    const statusEmoji: Record<string, string> = {
      running: '🔄',
      paused: '⏸️',
      completed: '✅',
      cancelled: '❌',
      error: '🔴',
    };

    // If no subcommand, show help
    if (!subCommand) {
      return {
        success: true,
        message: `📋 **任务控制指令**

用法: \`/task <子命令>\` 或 \`/task <任务描述>\`

**可用子命令:**
- \`<任务描述>\` - 启动新任务（直接输入任务描述）
- \`status\` - 查看当前任务状态
- \`list\` - 列出任务历史
- \`cancel\` - 取消当前任务
- \`pause\` - 暂停当前任务
- \`resume\` - 恢复暂停的任务

示例:
\`\`\`
/task 分析 src 目录下的文件依赖关系
/task status
/task list
/task cancel
/task pause
/task resume
\`\`\``,
      };
    }

    // Handle subcommands
    if (subCommand === 'status') {
      const currentTask = await services.getCurrentTask();
      if (!currentTask) {
        return {
          success: true,
          message: '📋 **当前任务状态**\n\n没有正在执行的任务',
        };
      }

      const progress = currentTask.progress > 0 ? `\n进度: ${currentTask.progress}%` : '';
      const currentStep = currentTask.currentStep ? `\n当前步骤: ${currentTask.currentStep}` : '';
      const errorMsg = currentTask.error ? `\n错误: ${currentTask.error}` : '';

      return {
        success: true,
        message: `📋 **当前任务状态**\n\n任务 ID: \`${currentTask.id}\`\n状态: ${statusEmoji[currentTask.status] || '❓'} ${currentTask.status}\n描述: ${currentTask.prompt}${progress}${currentStep}${errorMsg}\n创建时间: ${new Date(currentTask.createdAt).toLocaleString('zh-CN')}`,
      };
    }

    if (subCommand === 'list') {
      const tasks = await services.listTaskHistory(10);
      if (tasks.length === 0) {
        return {
          success: true,
          message: '📋 **任务历史**\n\n暂无任务记录',
        };
      }

      const tasksList = tasks.map(t => {
        const emoji = statusEmoji[t.status] || '❓';
        const date = new Date(t.createdAt).toLocaleDateString('zh-CN');
        const truncatedPrompt = t.prompt.length > 30 ? `${t.prompt.substring(0, 30)}...` : t.prompt;
        return `${emoji} \`${t.id}\` - ${truncatedPrompt} (${date})`;
      }).join('\n');

      return {
        success: true,
        message: `📋 **任务历史** (最近 ${tasks.length} 个)\n\n${tasksList}`,
      };
    }

    if (subCommand === 'cancel') {
      try {
        const cancelledTask = await services.cancelTask();
        if (!cancelledTask) {
          return {
            success: true,
            message: '📋 **取消任务**\n\n没有可取消的任务',
          };
        }
        return {
          success: true,
          message: `✅ **任务已取消**\n\n任务 ID: \`${cancelledTask.id}\`\n描述: ${cancelledTask.prompt}`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    if (subCommand === 'pause') {
      try {
        const pausedTask = await services.pauseTask();
        if (!pausedTask) {
          return {
            success: true,
            message: '📋 **暂停任务**\n\n没有可暂停的任务',
          };
        }
        return {
          success: true,
          message: `⏸️ **任务已暂停**\n\n任务 ID: \`${pausedTask.id}\`\n描述: ${pausedTask.prompt}\n\n使用 \`/task resume\` 恢复任务`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    if (subCommand === 'resume') {
      try {
        const resumedTask = await services.resumeTask();
        if (!resumedTask) {
          return {
            success: true,
            message: '📋 **恢复任务**\n\n没有可恢复的任务',
          };
        }
        return {
          success: true,
          message: `▶️ **任务已恢复**\n\n任务 ID: \`${resumedTask.id}\`\n描述: ${resumedTask.prompt}\n\n任务继续执行中...`,
        };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    // If not a valid subcommand, treat the entire input as a task prompt
    const prompt = rawText.replace(/^\/task\s+/i, '').trim();

    if (!prompt) {
      return {
        success: false,
        error: '请提供任务描述。\n\n用法: `/task <任务描述>`',
      };
    }

    // Start a new task
    try {
      const task = await services.startTask(prompt, chatId, userId);
      return {
        success: true,
        message: `✅ **任务已启动**\n\n任务 ID: \`${task.id}\`\n描述: ${task.prompt}\n\n任务正在执行中...`,
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}

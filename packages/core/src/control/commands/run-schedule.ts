/**
 * /run-schedule command handler.
 *
 * Issue #3249: Manual schedule trigger via control command.
 * Allows users to trigger a scheduled task immediately by ID.
 *
 * Usage:
 *   /run-schedule <task-id>   — Trigger a specific task
 *   /run-schedule list        — List all active scheduled tasks
 *
 * @module control/commands/run-schedule
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { ControlHandlerContext, CommandHandler } from '../types.js';

/**
 * /run-schedule 命令处理
 *
 * Issue #3249: Manual schedule trigger.
 */
export const handleRunSchedule: CommandHandler = async (
  command: ControlCommand,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  const { scheduler } = context;

  if (!scheduler) {
    return {
      success: false,
      message: '⚠️ 调度器未初始化',
    };
  }

  const args = (command.data?.args as string[] | undefined) ?? [];
  const [taskId] = args;

  // No argument → list active tasks
  if (!taskId) {
    const jobs = scheduler.getActiveJobs();
    if (jobs.length === 0) {
      return {
        success: true,
        message: '📋 当前没有活跃的定时任务',
      };
    }
    const lines = jobs.map(
      (j) => `- **${j.task.name}** (\`${j.taskId}\`)`
    );
    return {
      success: true,
      message: ['📋 **活跃定时任务**', '', ...lines, '', '使用 `/run-schedule <task-id>` 立即触发'].join('\n'),
    };
  }

  // Trigger the task
  const triggered = await scheduler.triggerTask(taskId);

  if (triggered) {
    return {
      success: true,
      message: `✅ 定时任务 \`${taskId}\` 已触发`,
    };
  }

  return {
    success: false,
    message: `❌ 未找到或已禁用的任务: \`${taskId}\``,
  };
};

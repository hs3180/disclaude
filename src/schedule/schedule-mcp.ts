/**
 * Schedule MCP Tools - In-process tools for schedule management.
 *
 * This module provides tools for creating, listing, and managing
 * scheduled tasks via natural language interaction.
 *
 * Tools provided:
 * - create_schedule: Create a new scheduled task
 * - list_schedules: List all scheduled tasks for current chat
 * - delete_schedule: Delete a scheduled task
 * - toggle_schedule: Enable/disable a scheduled task
 */

import { createLogger } from '../utils/logger.js';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ScheduleManager } from './schedule-manager.js';
import type { Scheduler } from './scheduler.js';

const logger = createLogger('ScheduleMCP');

/**
 * Registry for ScheduleManager and Scheduler instances.
 * Set during Execution Node initialization.
 */
let scheduleManagerInstance: ScheduleManager | null = null;
let schedulerInstance: Scheduler | null = null;

/**
 * Register ScheduleManager instance.
 */
export function setScheduleManager(manager: ScheduleManager): void {
  scheduleManagerInstance = manager;
  logger.info('ScheduleManager registered');
}

/**
 * Register Scheduler instance.
 */
export function setScheduler(scheduler: Scheduler): void {
  schedulerInstance = scheduler;
  logger.info('Scheduler registered');
}

/**
 * Get ScheduleManager instance.
 */
function getScheduleManager(): ScheduleManager {
  if (!scheduleManagerInstance) {
    throw new Error('ScheduleManager not registered. Call setScheduleManager() first.');
  }
  return scheduleManagerInstance;
}

/**
 * Get Scheduler instance.
 */
function getScheduler(): Scheduler {
  if (!schedulerInstance) {
    throw new Error('Scheduler not registered. Call setScheduler() first.');
  }
  return schedulerInstance;
}

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

/**
 * Helper to format cron expression for display.
 */
function formatCron(cron: string): string {
  // Simple cron explanation (cron format: minute hour day month weekday)
  const parts = cron.split(' ');
  if (parts.length !== 5) {
    return cron;
  }

  const [min, hour, day, month, weekday] = parts;

  // Daily at specific time
  if (day === '*' && month === '*' && weekday === '*') {
    return `每天 ${hour}:${min.padStart(2, '0')}`;
  }

  // Weekly on specific weekday
  if (day === '*' && month === '*' && weekday !== '*') {
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${weekdays[parseInt(weekday)]} ${hour}:${min.padStart(2, '0')}`;
  }

  // Default: show raw cron
  return cron;
}

/**
 * Tool: create_schedule
 *
 * Creates a new scheduled task.
 * The LLM should convert natural language time to cron expression.
 */
export const createScheduleTool = tool(
  'create_schedule',
  `Create a new scheduled task.

The task will execute the given prompt at the specified schedule.

**Cron Format**: minute hour day month weekday
Examples:
- "0 9 * * *" - Every day at 9:00
- "30 14 * * 5" - Every Friday at 14:30
- "0 10 1 * *" - On the 1st of every month at 10:00

**Parameters**:
- name: Human-readable task name (e.g., "每日邮件提醒")
- cron: Cron expression for schedule
- prompt: The prompt/task to execute when triggered
- chatId: The Feishu chat ID (use your context chatId)

After creation, the task will be automatically scheduled and will send
notifications to the chat when it executes.`,
  {
    name: z.string().describe('Human-readable task name'),
    cron: z.string().describe('Cron expression (minute hour day month weekday)'),
    prompt: z.string().describe('The prompt to execute when task triggers'),
    chatId: z.string().describe('Feishu chat ID (use your context chatId)'),
  },
  async ({ name, cron, prompt, chatId }) => {
    try {
      logger.info({ name, cron, chatId }, 'Creating scheduled task');

      const manager = getScheduleManager();
      const scheduler = getScheduler();

      const task = await manager.create({
        name,
        cron,
        prompt,
        chatId,
      });

      // Add to scheduler
      scheduler.addTask(task);

      const scheduleDesc = formatCron(cron);
      return toolSuccess(
        `✅ 已创建定时任务「${  name  }」\n` +
        `- 执行时间: ${  scheduleDesc  }\n` +
        `- 任务 ID: ${  task.id  }\n\n` +
        '任务已启动，将在指定时间自动执行。'
      );

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'create_schedule failed');
      return toolSuccess(`❌ 创建定时任务失败: ${errorMessage}`);
    }
  }
);

/**
 * Tool: list_schedules
 *
 * Lists all scheduled tasks for the current chat.
 */
export const listSchedulesTool = tool(
  'list_schedules',
  `List all scheduled tasks for the current chat.

Shows task ID, name, schedule, and status (enabled/disabled).`,
  {
    chatId: z.string().describe('Feishu chat ID (use your context chatId)'),
  },
  async ({ chatId }) => {
    try {
      const manager = getScheduleManager();
      const tasks = await manager.listByChatId(chatId);

      if (tasks.length === 0) {
        return toolSuccess('📋 当前聊天没有定时任务。\n\n使用 create_schedule 创建新任务。');
      }

      const lines = [`📋 当前聊天有 ${tasks.length} 个定时任务：\n`];

      tasks.forEach((task, index) => {
        const status = task.enabled ? '✅ 已启用' : '⏸️ 已暂停';
        const scheduleDesc = formatCron(task.cron);
        const lastExec = task.lastExecutedAt
          ? `\n   上次执行: ${new Date(task.lastExecutedAt).toLocaleString('zh-CN')}`
          : '';

        lines.push(
          `${index + 1}. 「${task.name}」\n` +
          `   执行时间: ${scheduleDesc}\n` +
          `   状态: ${status}\n` +
          `   ID: ${task.id}${lastExec}\n`
        );
      });

      return toolSuccess(lines.join('\n'));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'list_schedules failed');
      return toolSuccess(`❌ 获取定时任务列表失败: ${errorMessage}`);
    }
  }
);

/**
 * Tool: delete_schedule
 *
 * Deletes a scheduled task.
 */
export const deleteScheduleTool = tool(
  'delete_schedule',
  `Delete a scheduled task.

The task will be permanently removed and will no longer execute.

Use list_schedules to find the task ID first.`,
  {
    id: z.string().describe('Task ID to delete'),
    chatId: z.string().describe('Feishu chat ID (for verification)'),
  },
  async ({ id, chatId }) => {
    try {
      const manager = getScheduleManager();
      const scheduler = getScheduler();

      // Verify task belongs to this chat
      const task = await manager.get(id);
      if (!task) {
        return toolSuccess(`❌ 未找到任务 ID: ${  id}`);
      }

      if (task.chatId !== chatId) {
        return toolSuccess('❌ 无权删除此任务');
      }

      // Remove from scheduler
      scheduler.removeTask(id);

      // Delete from storage
      await manager.delete(id);

      return toolSuccess(`✅ 已删除定时任务「${  task.name  }」`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'delete_schedule failed');
      return toolSuccess(`❌ 删除定时任务失败: ${errorMessage}`);
    }
  }
);

/**
 * Tool: toggle_schedule
 *
 * Enables or disables a scheduled task.
 */
export const toggleScheduleTool = tool(
  'toggle_schedule',
  `Enable or disable a scheduled task.

When disabled, the task will not execute but is still retained.
Use this to temporarily pause a task without deleting it.`,
  {
    id: z.string().describe('Task ID to toggle'),
    enabled: z.boolean().describe('true to enable, false to disable'),
    chatId: z.string().describe('Feishu chat ID (for verification)'),
  },
  async ({ id, enabled, chatId }) => {
    try {
      const manager = getScheduleManager();
      const scheduler = getScheduler();

      // Verify task belongs to this chat
      const task = await manager.get(id);
      if (!task) {
        return toolSuccess(`❌ 未找到任务 ID: ${  id}`);
      }

      if (task.chatId !== chatId) {
        return toolSuccess('❌ 无权修改此任务');
      }

      // Update status
      await manager.toggle(id, enabled);

      // Update scheduler
      if (enabled) {
        scheduler.addTask({ ...task, enabled });
      } else {
        scheduler.removeTask(id);
      }

      const action = enabled ? '已启用' : '已暂停';
      return toolSuccess(`✅ ${  action  }定时任务「${  task.name  }」`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error }, 'toggle_schedule failed');
      return toolSuccess(`❌ 修改定时任务状态失败: ${errorMessage}`);
    }
  }
);

/**
 * SDK MCP Server factory for Schedule tools.
 *
 * Each call creates a new MCP server instance with its own Protocol.
 * This prevents transport conflicts when multiple Agent instances are active.
 *
 * Call this factory when creating Pilot queries:
 * ```typescript
 * mcpServers: {
 *   'schedule': createScheduleSdkMcpServer(),
 * }
 * ```
 */
export function createScheduleSdkMcpServer() {
  return createSdkMcpServer({
    name: 'schedule',
    version: '1.0.0',
    tools: [
      createScheduleTool,
      listSchedulesTool,
      deleteScheduleTool,
      toggleScheduleTool,
    ],
  });
}

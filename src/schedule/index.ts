/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: CRUD operations for scheduled tasks
 * - Scheduler: Cron-based task execution
 * - Schedule MCP Tools: LLM-callable tools for schedule management
 *
 * @see Issue #3 - Scheduled task feature
 */

export { ScheduleManager, type ScheduledTask, type CreateScheduleOptions } from './schedule-manager.js';
export { Scheduler, type SchedulerOptions } from './scheduler.js';
export {
  createScheduleSdkMcpServer,
  setScheduleManager,
  setScheduler,
} from './schedule-mcp.js';

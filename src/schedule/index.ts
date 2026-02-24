/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: CRUD operations for scheduled tasks
 * - Scheduler: Cron-based task execution
 * - Schedule MCP Tools: LLM-callable tools for schedule management
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 *
 * @see Issue #3 - Scheduled task feature
 * @see Issue #79 - Refactor to file-based configuration
 */

export { ScheduleManager, type ScheduledTask, type CreateScheduleOptions, type ScheduleManagerOptions } from './schedule-manager.js';
export { Scheduler, type SchedulerOptions } from './scheduler.js';
export {
  createScheduleSdkMcpServer,
  setScheduleManager,
  setScheduler,
} from './schedule-mcp.js';
export { ScheduleFileScanner, type ScheduleFileTask, type ScheduleFileScannerOptions } from './schedule-file-scanner.js';
export { ScheduleFileWatcher, type OnFileAdded, type OnFileChanged, type OnFileRemoved, type ScheduleFileWatcherOptions } from './schedule-file-watcher.js';

/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: CRUD operations for scheduled tasks
 * - Scheduler: Cron-based task execution
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 *
 * @see Issue #3 - Scheduled task feature
 * @see Issue #79 - Refactor to file-based configuration
 * @see Issue #89 - Blocking mechanism for scheduled tasks
 * @see Issue #123 - Remove MCP dependency, use basic tools directly
 */

export { ScheduleManager, type ScheduledTask, type CreateScheduleOptions, type ScheduleManagerOptions } from './schedule-manager.js';
export { Scheduler, type SchedulerOptions, type FeedbackChannelContext } from './scheduler.js';
export {
  ScheduleFileScanner,
  ScheduleFileWatcher,
  type ScheduleFileTask,
  type ScheduleFileScannerOptions,
  type OnFileAdded,
  type OnFileChanged,
  type OnFileRemoved,
  type ScheduleFileWatcherOptions,
} from './schedule-watcher.js';

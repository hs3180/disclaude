/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: Query operations for scheduled tasks
 * - Scheduler: Cron-based task execution
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 *
 * Note: CRUD operations (create/update/delete) are handled via file system directly.
 * Users create schedule files manually, and ScheduleFileWatcher auto-loads them.
 *
 * @see Issue #3 - Scheduled task feature
 * @see Issue #79 - Refactor to file-based configuration
 * @see Issue #89 - Blocking mechanism for scheduled tasks
 * @see Issue #123 - Remove MCP dependency, use basic tools directly
 * @see Issue #354 - Remove unused lastExecutedAt maintenance
 * @see Issue #355 - Remove unused CRUD methods
 */

export { ScheduleManager, type ScheduledTask, type ScheduleManagerOptions } from './schedule-manager.js';
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

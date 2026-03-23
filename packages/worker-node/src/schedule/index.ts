/**
 * Schedule module - Scheduled task management.
 *
 * This module provides:
 * - ScheduleManager: Query operations for scheduled tasks
 * - Scheduler: Cron-based task execution (with dependency injection)
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 * - CooldownManager: Manages cooldown periods for tasks
 *
 * Note: CRUD operations (create/update/delete) are handled via file system directly.
 * Users create schedule files manually, and ScheduleFileWatcher auto-loads them.
 *
 * @module @disclaude/worker-node/schedule
 *
 * @see Issue #3 - Scheduled task feature
 * @see Issue #79 - Refactor to file-based configuration
 * @see Issue #89 - Blocking mechanism for scheduled tasks
 * @see Issue #123 - Remove MCP dependency, use basic tools directly
 * @see Issue #354 - Remove unused lastExecutedAt maintenance
 * @see Issue #355 - Remove unused CRUD methods
 * @see Issue #869 - Cooldown period for scheduled tasks
 * @see Issue #1041 - Migrate to @disclaude/worker-node package
 */

// Issue #1446: Re-export ScheduleManager and Scheduler from core to eliminate duplicate implementations
export { ScheduleManager, type ScheduledTask, type ScheduleManagerOptions } from '@disclaude/core';
export { Scheduler, type SchedulerOptions, type SchedulerCallbacks, type TaskExecutor } from '@disclaude/core';
// ScheduleFileScanner, ScheduleFileWatcher re-exported from core (Issue #1395)
export {
  ScheduleFileScanner,
  ScheduleFileWatcher,
  type ScheduleFileTask,
  type ScheduleFileScannerOptions,
  type OnFileAdded,
  type OnFileChanged,
  type OnFileRemoved,
  type ScheduleFileWatcherOptions,
  CooldownManager,
  type CooldownManagerOptions,
} from '@disclaude/core';

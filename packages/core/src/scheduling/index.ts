/**
 * Scheduling module - Core scheduling utilities.
 *
 * This module provides:
 * - CooldownManager: Manages cooldown periods for scheduled tasks
 * - ScheduledTask: Type definition for scheduled tasks
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 * - ScheduleManager: Query operations for scheduled tasks
 * - Scheduler: Cron-based task execution (with dependency injection)
 *
 * @module @disclaude/core/scheduling
 */

// Types
export { type ScheduledTask } from './scheduled-task.js';

// Cooldown
export {
  CooldownManager,
  type CooldownManagerOptions,
} from './cooldown-manager.js';

// File Scanner & Watcher
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

// Manager
export {
  ScheduleManager,
  type ScheduleManagerOptions
} from './schedule-manager.js';

// Scheduler
export {
  Scheduler,
  type SchedulerCallbacks,
  type TaskExecutor,
  type SchedulerOptions,
} from './scheduler.js';

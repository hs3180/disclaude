/**
 * Scheduling module - Core scheduling utilities.
 *
 * This module provides:
 * - CooldownManager: Manages cooldown periods for scheduled tasks
 * - ChatStore: File-based storage for temporary chat lifecycle records (Issue #1703)
 * - ScheduledTask: Type definition for scheduled tasks
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 * - ScheduleManager: Query operations for scheduled tasks
 * - Scheduler: Cron-based + event-driven task execution (Issue #1953)
 * - EventTriggerManager: File-watch based event triggers (Issue #1953)
 * - ScheduleExecutor: Unified executor factory (Issue #1382)
 *
 * @module @disclaude/core/scheduling
 */

// Types
export { type ScheduledTask, type ScheduleWatchEntry } from './scheduled-task.js';

// Cooldown
export {
  CooldownManager,
  type CooldownManagerOptions,
} from './cooldown-manager.js';

// Chat Store (Issue #1703: temporary chat lifecycle)
export {
  ChatStore,
  type ChatStoreOptions,
  type TempChatRecord,
  type TempChatResponse,
  type RegisterTempChatOptions,
} from './chat-store.js';

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

// Event Trigger (Issue #1953: event-driven schedule triggers)
export {
  EventTriggerManager,
  type EventTriggerManagerOptions,
  type OnTrigger,
} from './event-trigger.js';

// Schedule Executor (Issue #1382)
export {
  createScheduleExecutor,
  type ScheduleAgent,
  type ScheduleAgentFactory,
  type ScheduleExecutorOptions,
} from './schedule-executor.js';

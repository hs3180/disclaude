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
 * - Scheduler: Cron-based task execution (with dependency injection)
 * - ScheduleExecutor: Unified executor factory (Issue #1382)
 * - TriggerManager: Signal-file-based event triggers (Issue #1953)
 * - EventTriggerWatcher: File-system path watching for event triggers (Issue #1953)
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

// Schedule Executor (Issue #1382)
export {
  createScheduleExecutor,
  type ScheduleAgent,
  type ScheduleAgentFactory,
  type ScheduleExecutorOptions,
} from './schedule-executor.js';

// Trigger Manager (Issue #1953: Event-driven triggers)
export {
  TriggerManager,
  type TriggerManagerOptions,
  type OnTrigger,
} from './trigger-manager.js';

// Event Trigger Watcher (Issue #1953: Event-driven triggers)
export {
  EventTriggerWatcher,
  type EventTriggerWatcherOptions,
} from './event-trigger-watcher.js';

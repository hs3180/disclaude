/**
 * Scheduling module - Core scheduling utilities.
 *
 * This module provides:
 * - CooldownManager: Manages cooldown periods for scheduled tasks
 * - BotChatMappingStore: Context-to-chatId mapping for bot groups (Issue #2947)
 * - ScheduledTask: Type definition for scheduled tasks
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 * - ScheduleManager: Query operations for scheduled tasks
 * - Scheduler: Cron-based task execution (via InputMessageRouter)
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

// Bot Chat Mapping (Issue #2947: context-to-chatId mapping)
export {
  BotChatMappingStore,
  makeMappingKey,
  parseGroupNameToKey,
  purposeFromKey,
  type MappingPurpose,
  type MappingEntry,
  type MappingTable,
  type RebuildResult,
  type BotChatMappingStoreOptions,
} from './bot-chat-mapping.js';

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
  TaskTimeoutError,
  type SchedulerCallbacks,
  type SchedulerOptions,
} from './scheduler.js';

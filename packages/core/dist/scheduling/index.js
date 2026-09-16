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
// Cooldown
export { CooldownManager, } from './cooldown-manager.js';
// Failure streaks (Issue #4648 residual ⑥: restart-surviving failure counts)
export { TaskFailureStore, } from './task-failure-store.js';
// Bot Chat Mapping (Issue #2947: context-to-chatId mapping)
export { BotChatMappingStore, makeMappingKey, parseGroupNameToKey, purposeFromKey, } from './bot-chat-mapping.js';
// File Scanner & Watcher
export { ScheduleFileScanner, ScheduleFileWatcher, } from './schedule-watcher.js';
// Manager
export { ScheduleManager } from './schedule-manager.js';
// Scheduler
export { Scheduler, TaskTimeoutError, } from './scheduler.js';

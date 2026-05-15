/**
 * ETA Module - Task ETA estimation system (Issue #1234).
 *
 * Provides Markdown-based task execution recording and ETA estimation.
 * Uses non-structured Markdown free storage for task records and rules.
 *
 * @module eta
 */

export { TaskRecordManager } from './task-records.js';

export type {
  TaskRecord,
  TaskRecordManagerOptions,
  ParsedTaskRecord,
  TaskType,
} from './types.js';

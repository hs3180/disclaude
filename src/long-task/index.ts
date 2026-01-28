/**
 * Long task module - orchestrates complex multi-step tasks.
 *
 * Provides a workflow for breaking down complex user requests into
 * linear subtasks, each handled by an isolated agent with context
 * isolation and result persistence.
 */

export { TaskPlanner } from './planner.js';
export { SubtaskExecutor } from './executor.js';
export { LongTaskManager } from './manager.js';
export type {
  SubtaskInput,
  SubtaskOutput,
  Subtask,
  LongTaskPlan,
  LongTaskStatus,
  LongTaskState,
  SubtaskResult,
  LongTaskConfig,
} from './types.js';

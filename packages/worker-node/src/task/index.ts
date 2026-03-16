/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 * Re-exports common utilities from @disclaude/core and worker-node specific implementations.
 *
 * @see Issue #1041 - Task utilities migrated to @disclaude/core
 */

// Re-export types from @disclaude/core
export type { AgentMessage, TaskDefinitionDetails } from '@disclaude/core';

// Re-export utilities from @disclaude/core
export { DialogueMessageTracker } from '@disclaude/core';

// Re-export Task Files from @disclaude/core
export { TaskFileManager, type TaskFileManagerConfig } from '@disclaude/core';

// Re-export Task Tracker from @disclaude/core
export { TaskTracker } from '@disclaude/core';

// Re-export Task File Watcher from @disclaude/core
export { TaskFileWatcher, type TaskFileWatcherOptions, type OnTaskCreated } from '@disclaude/core';

// Re-export Reflection Pattern from @disclaude/core
export {
  ReflectionController,
  TerminationConditions,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionMetrics,
  type ReflectionEvent,
  type ReflectionEvaluationResult,
  type ReflectionContext,
} from '@disclaude/core';

export {
  TaskFlowOrchestrator,
  type TaskFlowOrchestratorConfig,
  type SetMessageSentCallbackFn,
} from './task-flow-orchestrator.js';

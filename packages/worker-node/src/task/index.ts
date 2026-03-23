/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 * Re-exports common utilities from @disclaude/core.
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

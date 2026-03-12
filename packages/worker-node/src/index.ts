/**
 * @disclaude/worker-node
 *
 * Worker Node process for disclaude.
 *
 * This package contains:
 * - WorkerNode class (Issue #1041)
 * - WorkerNodeConfig type definition
 * - File transfer client (FileClient)
 * - Schedule module (ScheduleManager, Scheduler, etc.)
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

// Re-export types from @disclaude/core
export type { WorkerNodeConfig } from '@disclaude/core';
export type {
  FileRef,
  FileUploadRequest,
  FileUploadResponse,
  FileDownloadResponse,
} from '@disclaude/core';
export { getWorkerNodeCapabilities } from '@disclaude/core';

// WorkerNode class
export { WorkerNode, type WorkerNodeOptions } from './worker-node.js';

// Dependency interfaces (for external use)
export type {
  WorkerNodeDependencies,
  ChatAgent,
  AgentPoolInterface,
  PilotCallbacks,
  ChatAgentFactory,
  ScheduleAgentFactory,
  MessageCallbacks,
  TaskFlowOrchestratorInterface,
  TaskFlowOrchestratorFactory,
  GenerateInteractionPromptCallback,
  SchedulerInterface,
  ScheduleFileWatcherInterface,
  ScheduleManagerInterface,
} from './types.js';

// WebSocket message types (re-exported from @disclaude/core)
export type {
  PromptMessage,
  CommandMessage,
  FeedbackMessage,
  CardActionMessage,
  FeishuApiResponseMessage,
} from './types.js';

// File transfer client
export { FileClient, type FileClientConfig } from './file-client/index.js';

// Schedule module
export {
  ScheduleManager,
  Scheduler,
  ScheduleFileScanner,
  ScheduleFileWatcher,
  CooldownManager,
  // Types
  type ScheduledTask,
  type ScheduleManagerOptions,
  type SchedulerOptions,
  type SchedulerCallbacks,
  type TaskExecutor,
  type ScheduleFileTask,
  type ScheduleFileScannerOptions,
  type OnFileAdded,
  type OnFileChanged,
  type OnFileRemoved,
  type ScheduleFileWatcherOptions,
  type CooldownManagerOptions,
} from './schedule/index.js';

// Package version
export const WORKER_NODE_VERSION = '0.0.4';

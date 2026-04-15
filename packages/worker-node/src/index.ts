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
  AgentPoolInterface,
  ChatAgentCallbacks,
  ChatAgent as ChatAgentInterface,
  ChatAgentFactory,
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

// Task module (Issue #1041 - migrated from main package)
export {
  DialogueMessageTracker,
  TaskFileManager,
  TaskTracker,
  // Types
  type TaskFileManagerConfig,
  type TaskDefinitionDetails,
} from './task/index.js';

export type { AgentMessage } from '@disclaude/core';

// Agents module (Issue #1041 - AgentFactory and ChatAgent)
export { AgentFactory, type AgentCreateOptions, toChatAgentCallbacks } from './agents/factory.js';
export { ChatAgent, type ChatAgentConfig } from './agents/chat-agent/index.js';
// Backward compatibility aliases (deprecated — use ChatAgent and ChatAgentConfig directly)
export { ChatAgent as Pilot, type ChatAgentConfig as PilotConfig } from './agents/chat-agent/index.js';
// Note: ChatAgentCallbacks is already exported from ./types.js above
// ChatAgentConfig now includes optional messageBuilderOptions (Issue #1499)

// Conversation module (Issue #1041 - now re-exported from core)
export {
  ConversationOrchestrator,
  ConversationSessionManager,
  MessageQueue,
  type ConversationOrchestratorConfig,
  type ConversationSessionManagerConfig,
  type QueuedMessage,
  type SessionState,
  type SessionCallbacks,
  type CreateSessionOptions,
  type ProcessMessageResult,
  type SessionStats,
  type ConversationMessageContext,
} from '@disclaude/core';

// Backward compatibility: alias ConversationMessageContext as MessageContext
export type { ConversationMessageContext as MessageContext } from '@disclaude/core';

// Agents module - RestartManager re-exported from core (Issue #1041)
export {
  RestartManager,
  type RestartManagerConfig,
  type RestartDecision,
} from '@disclaude/core';

// Agent types re-exported from @disclaude/core (Issue #1041, Issue #1501)
// Note: ChatAgent type is in ./types.js for WorkerNode dependencies
// The core has the unified ChatAgent interface for agent classification
// Issue #1501: SkillAgent and Subagent types removed from core
export type {
  Disposable,
  AgentUserInput as UserInput,
  AgentProvider,
  BaseAgentConfig,
  ChatAgentConfig as CoreChatAgentConfig,
  AgentConfig,
  AgentFactoryInterface,
} from '@disclaude/core';

export {
  isChatAgent,
  isDisposable,
} from '@disclaude/core';

// File transfer module (Issue #1041 - migrated from main package)
// FileRef is already exported from @disclaude/core above
export type {
  InboundAttachment,
  OutboundFile,
} from '@disclaude/core';

export {
  createFileRef,
  createInboundAttachment,
  createOutboundFile,
} from '@disclaude/core';

export { AttachmentManager } from './file-transfer/inbound/attachment-manager.js';

export {
  FileStorageService,
  type FileStorageConfig,
} from './file-transfer/node-transfer/file-storage.js';

export {
  FileClient as NodeFileClient,
  type FileClientConfig as NodeFileClientConfig,
} from './file-transfer/node-transfer/file-client.js';

// Package version
export const WORKER_NODE_VERSION = '0.0.4';

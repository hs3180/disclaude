/**
 * Dependency interfaces for WorkerNode.
 *
 * These interfaces define the dependencies that must be injected into WorkerNode
 * from the main application, allowing WorkerNode to remain in the package
 * without importing from src/.
 *
 * @see Issue #1041 - Separate Worker Node code to @disclaude/worker-node
 */

import type { Logger } from 'pino';
import type { FileRef, FeishuCard, ChannelCapabilities } from '@disclaude/core';

// ============================================================================
// ChatAgent Interface
// ============================================================================

/**
 * ChatAgent - Continuous conversation agent interface.
 *
 * Minimal interface for the methods used by WorkerNode.
 */
export interface ChatAgent {
  /** Agent type identifier */
  readonly type: 'chat';

  /** Agent name for logging */
  readonly name: string;

  /**
   * Process a message from a user.
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: FileRef[],
    chatHistoryContext?: string
  ): void;

  /**
   * Execute a one-shot query (for CLI and scheduled tasks).
   */
  executeOnce(
    chatId: string,
    text: string,
    messageId?: string,
    senderOpenId?: string
  ): Promise<void>;

  /**
   * Reset the agent session.
   */
  reset(chatId?: string, keepContext?: boolean): void;

  /**
   * Stop the current query without resetting the session.
   * Issue #1349: /stop command
   */
  stop(chatId?: string): boolean;

  /**
   * Dispose of resources.
   */
  dispose(): void;
}

// ============================================================================
// AgentPool Interface
// ============================================================================

/**
 * AgentPoolInterface - Interface for managing ChatAgent instances.
 *
 * Used by WorkerNode to get/create agents per chatId.
 */
export interface AgentPoolInterface {
  /**
   * Get or create a ChatAgent instance for the given chatId.
   */
  getOrCreateChatAgent(chatId: string): ChatAgent;

  /**
   * Reset the ChatAgent for a chatId.
   */
  reset(chatId: string, keepContext?: boolean): void;

  /**
   * Stop the current query for a chatId without resetting the session.
   * Issue #1349: /stop command
   */
  stop(chatId: string): boolean;

  /**
   * Dispose all agents.
   */
  disposeAll(): void;
}

// ============================================================================
// Agent Factory Functions
// ============================================================================

/**
 * ChatAgentCallbacks - Callbacks for ChatAgent to send messages.
 *
 * Used when creating ChatAgent instances.
 */
export interface ChatAgentCallbacks {
  /** Send a text message */
  sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
  /** Send an interactive card */
  sendCard: (chatId: string, card: FeishuCard, description?: string, parentMessageId?: string) => Promise<void>;
  /** Send a file */
  sendFile: (chatId: string, filePath: string) => Promise<void>;
  /** Called when query completes */
  onDone?: (chatId: string, parentMessageId?: string) => Promise<void>;
  /** Get channel capabilities for a chat (Issue #582) */
  getCapabilities?: (chatId: string) => ChannelCapabilities | undefined;
  /** Get chat history for first message context (Issue #1230, #1863) */
  getChatHistory?: (chatId: string) => Promise<string | undefined>;
}

/**
 * ChatAgentFactory - Factory function to create ChatAgent instances.
 */
export type ChatAgentFactory = (chatId: string, callbacks: ChatAgentCallbacks) => ChatAgent;

// ============================================================================
// Scheduler Types
// ============================================================================

// Import and re-export from schedule module
import type { ScheduledTask as ScheduledTaskType } from './schedule/index.js';
export type { ScheduledTask } from './schedule/index.js';

/**
 * SchedulerInterface - Interface for the scheduler.
 */
export interface SchedulerInterface {
  /**
   * Start the scheduler.
   */
  start(): Promise<void>;

  /**
   * Stop the scheduler.
   */
  stop(): void;

  /**
   * Add a task to the scheduler.
   */
  addTask(task: ScheduledTaskType): void;

  /**
   * Remove a task from the scheduler.
   */
  removeTask(taskId: string): void;
}

/**
 * ScheduleFileWatcherInterface - Interface for the schedule file watcher.
 */
export interface ScheduleFileWatcherInterface {
  /**
   * Start the file watcher.
   */
  start(): Promise<void>;

  /**
   * Stop the file watcher.
   */
  stop(): void;
}

/**
 * ScheduleManagerInterface - Interface for the schedule manager.
 */
export interface ScheduleManagerInterface {
  // Add methods as needed
}

// ============================================================================
// WorkerNode Dependencies
// ============================================================================

/**
 * WorkerNodeDependencies - Container for all injected dependencies.
 *
 * WorkerNode requires these dependencies to be provided by the main application.
 * This allows WorkerNode to remain in the @disclaude/worker-node package
 * without importing from src/.
 */
export interface WorkerNodeDependencies {
  /** Function to get the workspace directory */
  getWorkspaceDir: () => string;

  /** Factory to create ChatAgent instances (for AgentPool and Scheduler).
   *  Issue #2345 Phase 5: Unified from createChatAgent + createScheduleAgent.
   *  Issue #2513: No longer distinguishes between agent types. */
  createAgent: ChatAgentFactory;

  /** Logger instance */
  logger: Logger;
}

// ============================================================================
// WebSocket Message Types (re-exported from @disclaude/core)
// ============================================================================

// Re-export types used by WorkerNode
export type {
  PromptMessage,
  CommandMessage,
  FeedbackMessage,
  CardActionMessage,
  FeishuApiResponseMessage,
} from '@disclaude/core';

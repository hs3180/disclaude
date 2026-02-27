/**
 * Agents module - All agent types and base class.
 *
 * Agent Categories (Issue #282):
 * - ChatAgent: Conversational agents (Pilot)
 * - TaskAgent: Task-oriented agents (Evaluator, Executor, Reporter)
 * - ToolAgent: Tool-specific agents (SiteMiner)
 *
 * Design principle: "Composition over inheritance"
 *
 * Provides:
 * - BaseAgent: Abstract base class for all agents
 * - Evaluator: Task completion evaluation specialist
 * - Executor: Task execution specialist
 * - Reporter: Communication and instruction generation specialist
 * - Pilot: Platform-agnostic direct chat with streaming input
 * - SessionManager: Pilot session lifecycle management
 * - ConversationContext: Pilot conversation context tracking
 */

// Type definitions for agent classification
export {
  type AgentCategory,
  type AgentType,
  type ChatAgentType,
  type TaskAgentType,
  type ToolAgentType,
  type TaskAgentRole,
  type AgentLifecyclePhase,
  type AgentLifecycleEvent,
  type LifecycleObserver,
  isChatAgent,
  isTaskAgent,
  isToolAgent,
} from './types.js';

// Task agent capability (composition-based shared functionality)
export {
  TaskAgentCapability,
  type TaskAgentCapabilityOptions,
  getTaskAgentTools,
  TASK_AGENT_TOOLS,
} from './task-agent-capability.js';

// Base class
export {
  BaseAgent,
  type BaseAgentConfig,
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
} from './base-agent.js';

// Task agents
export { Evaluator, type EvaluatorConfig } from './evaluator.js';
export { Executor, type ExecutorConfig, type TaskProgressEvent, type TaskResult } from './executor.js';
export { Reporter } from './reporter.js';

// Conversational agent
export { Pilot, type PilotCallbacks, type PilotConfig } from './pilot.js';

// Pilot support classes (extracted from Pilot for separation of concerns)
export { SessionManager, type PilotSession, type SessionManagerConfig } from './session-manager.js';
export { ConversationContext, type ConversationContextConfig } from './conversation-context.js';

// Site mining subagent
export {
  runSiteMiner,
  createSiteMiner,
  isPlaywrightAvailable,
  type SiteMinerResult,
  type SiteMinerOptions,
} from './site-miner.js';

// Factory
export { AgentFactory, type AgentCreateOptions } from './factory.js';

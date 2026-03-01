/**
 * Agents module - All agent types and base class.
 *
 * Provides:
 * - BaseAgent: Abstract base class for all agents
 * - Evaluator: Task completion evaluation specialist
 * - Executor: Task execution specialist
 * - Reporter: Communication and instruction generation specialist
 * - Pilot: Platform-agnostic direct chat with streaming input
 * - SessionManager: Pilot session lifecycle management
 * - ConversationContext: Pilot conversation context tracking
 *
 * Agent Type Classification (Issue #282):
 * - ChatAgent: Continuous conversation agents (Pilot)
 * - SkillAgent: Single-shot task agents (Evaluator, Executor, Reporter)
 * - Subagent: SkillAgent that can be used as a tool (SiteMiner)
 *
 * Unified Configuration Types (Issue #327):
 * - BaseAgentConfig: Base configuration for all agents
 * - ChatAgentConfig: Configuration for ChatAgent (Pilot)
 * - SkillAgentConfig: Configuration for SkillAgent (Evaluator, Executor, Reporter)
 * - SubagentConfig: Configuration for Subagent (SiteMiner)
 */

// Type definitions
export {
  type Disposable,
  type ChatAgent,
  type SkillAgent,
  type Subagent,
  type UserInput,
  type AgentConfig,
  type AgentFactoryInterface,
  // Unified configuration types (Issue #327)
  type AgentProvider,
  type BaseAgentConfig,
  type ChatAgentConfig,
  type SkillAgentConfig,
  type SubagentConfig,
  // Type guards
  isChatAgent,
  isSkillAgent,
  isSubagent,
  isDisposable,
} from './types.js';

// Base class
export {
  BaseAgent,
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
} from './base-agent.js';

// Task agents
export { Evaluator, type EvaluatorConfig } from './evaluator.js';
export { Executor, type ExecutorConfig, type TaskProgressEvent, type TaskResult } from './executor.js';

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

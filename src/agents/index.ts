/**
 * Agents module - All agent types and base class.
 *
 * Provides:
 * - BaseAgent: Abstract base class for all agents
 * - SkillAgent (NEW): Generic agent that executes skills from markdown files (Issue #413)
 * - Evaluator: Task completion evaluation specialist (legacy, use SkillAgent with evaluate.md)
 * - Executor: Task execution specialist (legacy, use SkillAgent with execute.md)
 * - Reporter: Communication and instruction generation specialist (legacy, use SkillAgent with report.md)
 * - Pilot: Platform-agnostic direct chat with streaming input
 * - SessionManager: Pilot session lifecycle management
 * - ConversationContext: Pilot conversation context tracking
 *
 * Agent Type Classification (Issue #282):
 * - ChatAgent: Continuous conversation agents (Pilot)
 * - SkillAgent: Single-shot task agents (Evaluator, Executor, Reporter, SkillAgent)
 * - Subagent: SkillAgent that can be used as a tool (SiteMiner)
 *
 * Unified Configuration Types (Issue #327):
 * - BaseAgentConfig: Base configuration for all agents
 * - ChatAgentConfig: Configuration for ChatAgent (Pilot)
 * - SkillAgentConfig: Configuration for SkillAgent (Evaluator, Executor, Reporter)
 * - SubagentConfig: Configuration for Subagent (SiteMiner)
 *
 * Simplified Architecture (Issue #413):
 * - Use SkillAgent with skill files (skills/evaluate.md, execute.md, report.md)
 * - Legacy Evaluator/Executor/Reporter classes still available for backward compatibility
 */

// Type definitions
export {
  type Disposable,
  type ChatAgent,
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

// Re-export SkillAgent interface as type alias for backward compatibility
export type { SkillAgent as SkillAgentInterface } from './types.js';

// Base class
export {
  BaseAgent,
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
} from './base-agent.js';

// Task agents (legacy - use SkillAgent with skill files instead)
export { Evaluator, type EvaluatorConfig } from './evaluator.js';
export { Executor, type ExecutorConfig, type TaskProgressEvent, type TaskResult } from './executor.js';
export { Reporter } from './reporter.js';

// Generic SkillAgent (Issue #413)
export {
  SkillAgent,
  SkillAgentFactory,
  parseSkillFile,
  type SkillConfig,
  type SkillAgentExecuteOptions,
} from './skill-agent.js';

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

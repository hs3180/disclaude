/**
 * Agents module - All agent types and base class.
 *
 * Provides:
 * - BaseAgent: Abstract base class for all agents
 * - SkillAgent: Generic agent that executes skills from markdown files (Issue #413)
 * - Pilot: Platform-agnostic direct chat with streaming input
 * - AgentPool: Manages Pilot instances per chatId (Issue #644)
 *
 * Agent Type Classification (Issue #282):
 * - ChatAgent: Continuous conversation agents (Pilot)
 * - SkillAgent: Single-shot task agents (SkillAgent with skill files)
 * - Subagent: SkillAgent that can be used as a tool (SiteMiner)
 *
 * Unified Configuration Types (Issue #327):
 * - BaseAgentConfig: Base configuration for all agents
 * - ChatAgentConfig: Configuration for ChatAgent (Pilot)
 * - SkillAgentConfig: Configuration for SkillAgent
 * - SubagentConfig: Configuration for Subagent (SiteMiner)
 *
 * Simplified Architecture (Issue #413):
 * - Use SkillAgent with skill files (skills/evaluator/SKILL.md, executor/SKILL.md)
 * - Legacy Evaluator/Executor classes removed
 *
 * Issue #644: Session Isolation
 * - Each Pilot is bound to a single chatId
 * - AgentPool manages chatId → Pilot mapping
 * - SessionManager is kept for backward compatibility but no longer used by Pilot
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

// Generic SkillAgent (Issue #413)
export {
  SkillAgent,
  type SkillAgentExecuteOptions,
} from './skill-agent.js';

// Conversational agent (Issue #697: refactored to pilot/ directory)
export { Pilot, type PilotCallbacks, type PilotConfig } from './pilot/index.js';

// Pilot support classes (extracted from Pilot for separation of concerns)
// Note: SessionManager is deprecated for Pilot (Issue #644) but kept for backward compatibility
export { SessionManager, type PilotSession, type SessionManagerConfig } from './session-manager.js';
export { ConversationContext, type ConversationContextConfig } from './conversation-context.js';

// AgentPool - Manages ChatAgent instances per chatId (Issue #644, Issue #711)
export { AgentPool, type AgentPoolConfig, type ChatAgentFactory } from './agent-pool.js';

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

// Task Complexity Agent (Issue #857)
export {
  TaskComplexityAgent,
  createTaskComplexityAgent,
  type TaskComplexityAgentConfig,
  type TaskComplexityResult,
  type ComplexityLevel,
} from './task-complexity-agent.js';

// Task History Storage (Issue #857)
export {
  TaskHistoryStorage,
  taskHistoryStorage,
  type TaskRecord,
  type TaskTypeStats,
} from './task-history.js';

// Unified SubagentManager (Issue #997)
export {
  SubagentManager,
  getSubagentManager,
  initSubagentManager,
  resetSubagentManager,
  type SubagentType,
  type SubagentStatus,
  type IsolationMode,
  type SubagentOptions,
  type SubagentHandle,
  type SubagentCallbacks,
  type SubagentResult,
} from './subagent-manager.js';

// Re-export SkillAgentManager for backward compatibility
export {
  SkillAgentManager,
  getSkillAgentManager,
  initSkillAgentManager,
  resetSkillAgentManager,
  type AgentStatus,
  type SkillAgentConfig,
  type SkillAgentInfo,
  type NotificationCallbacks,
} from './skill-agent-manager.js';

/**
 * Agents module - All agent types and base class.
 *
 * Provides:
 * - BaseAgent: Abstract base class for all agents
 * - Evaluator: Task completion evaluation specialist
 * - Executor: Task execution specialist
 * - Reporter: Communication and instruction generation specialist
 * - Pilot: Platform-agnostic direct chat with streaming input
 * - AgentFactory: Unified factory for creating Agent instances (Issue #129)
 */

// Base class
export {
  BaseAgent,
  type BaseAgentConfig,
  type SdkOptionsExtra,
  type IteratorYieldResult,
  type QueryStreamResult,
} from './base-agent.js';

// Task agents
export { Evaluator, type EvaluatorConfig, type EvaluatorInput } from './evaluator.js';
export { Executor, type ExecutorConfig, type TaskProgressEvent, type TaskResult } from './executor.js';
export { Reporter, type ReporterConfig } from './reporter.js';

// Conversational agent
export { Pilot, type PilotCallbacks, type PilotConfig } from './pilot.js';

// Factory
export {
  AgentFactory,
  type AgentType,
  type CreatePilotOptions,
  type CreateEvaluatorOptions,
  type CreateExecutorOptions,
  type CreateReporterOptions,
} from './agent-factory.js';

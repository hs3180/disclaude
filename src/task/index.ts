/**
 * Agent module exports.
 *
 * Architecture (Evaluation-Execution):
 * - Pilot: Handles user messages with deep-task skill for Task.md creation
 * - SkillAgent: Generic agent that executes skills from markdown files (Issue #413)
 * - ReflectionController: Manages iterative Execute-Evaluate-Reflect cycles
 *
 * Complete Workflow:
 * Flow 1: User request → Pilot (with deep-task skill) → Task.md
 * Flow 2: Task.md → ReflectionController (SkillAgent with skill files) → ...
 *
 * Evaluation-Execution Flow:
 * - SkillAgent with evaluator/SKILL.md assesses task completion
 * - SkillAgent with executor/SKILL.md executes tasks
 * - No intermediate planning layer - direct execution for faster response
 * - Real-time streaming of agent messages for immediate user feedback
 *
 * Session Management:
 * - ReflectionController internally manages sessions per taskId
 * - Each iteration creates fresh agent instances
 * - Context maintained via file-based communication (evaluation.md, execution.md)
 *
 * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
 * Simplified (Issue #413): Uses SkillAgent instead of Evaluator/Executor classes.
 */

// SkillAgent (Issue #413)
export { SkillAgent, type SkillAgentExecuteOptions } from '../agents/skill-agent.js';

// Reflection Pattern (Issue #283)
export {
  ReflectionController,
  TerminationConditions,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionContext,
  type ReflectionMetrics,
  type ReflectionEvent,
  type ReflectionEvaluationResult,
} from './reflection.js';

// Supporting modules
export { DialogueMessageTracker } from './dialogue-message-tracker.js';
export { parseBaseToolName, isUserFeedbackTool } from './mcp-utils.js';

// Feishu context MCP tools
export {
  feishuContextTools,
  send_user_feedback,
  send_file_to_feishu,
} from '../mcp/feishu-context-mcp.js';

// Note: task_done has been removed - completion is now detected via final_result.md

// Utility
export { extractText } from '../utils/sdk.js';

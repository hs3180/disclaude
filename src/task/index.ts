/**
 * Agent module exports.
 *
 * Architecture (Evaluation-Execution):
 * - Scout: Task initialization - creates Task.md with metadata
 * - Evaluator: Task completion evaluation
 * - Executor: Executes tasks directly with Reporter for progress updates
 * - DialogueOrchestrator: Manages direct Evaluator-Executor flow
 *
 * Complete Workflow:
 * Flow 1: User request → Scout → Task.md (metadata + original request)
 * Flow 2: Task.md → Evaluator (evaluate) → Executor (execute directly) → ...
 *
 * Evaluation-Execution Flow:
 * - Evaluator assesses task completion and identifies missing items
 * - Executor executes tasks directly with a single pseudo-subtask
 * - No intermediate planning layer - direct execution for faster response
 * - Real-time streaming of agent messages for immediate user feedback
 *
 * Session Management:
 * - Orchestrator internally manages sessions per messageId
 * - Each iteration creates fresh agent instances
 * - Context maintained via previousExecutorOutput between iterations
 */

// Core agents
export { Scout } from '../agents/scout.js';
export { Evaluator } from '../agents/evaluator.js';

// Bridges
export {
  DialogueOrchestrator,
  type DialogueOrchestratorConfig,
} from './dialogue-orchestrator.js';

export {
  IterationBridge,
  type IterationBridgeConfig,
  type IterationResult,
} from './iteration-bridge.js';

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

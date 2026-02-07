/**
 * Agent module exports.
 *
 * Architecture:
 * - Scout: Task initialization - creates Task.md with metadata
 * - Evaluator: Task completion evaluation
 * - Worker: Task execution with full tool access
 * - DialogueOrchestrator: Manages direct Evaluator-Worker flow
 *
 * Complete Workflow:
 * Flow 1: User request → Scout → Task.md (metadata + original request)
 * Flow 2: Task.md → Evaluator → Worker → ...
 *
 * Session Management:
 * - Orchestrator internally manages sessions per messageId
 * - SDK's native resume parameter handles session persistence
 */

// Core agents
export { Scout } from './scout.js';
export { Worker } from './worker.js';
export { Evaluator } from './evaluator.js';

// Bridges
export {
  DialogueOrchestrator,
  type DialogueOrchestratorConfig,
  type TaskPlanData,
} from './dialogue-orchestrator.js';

export {
  IterationBridge,
  type IterationBridgeConfig,
  type IterationResult,
} from './iteration-bridge.js';

// Supporting modules
export { DialogueMessageTracker } from './dialogue-message-tracker.js';
export { parseBaseToolName, isUserFeedbackTool, isTaskDoneTool } from './mcp-utils.js';

// Feishu context MCP tools
export {
  feishuContextTools,
  send_user_feedback,
  send_file_to_feishu,
} from '../mcp/feishu-context-mcp.js';

// Note: task_done is now an inline tool provided by the Evaluator agent
// and is not exported from the Feishu MCP server anymore

// Utility
export { extractText } from './evaluator.js';

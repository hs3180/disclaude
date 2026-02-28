/**
 * Agent module exports.
 *
 * Architecture (Evaluation-Execution - Issue #283):
 * - Pilot: Handles user messages with deep-task skill for Task.md creation
 * - Evaluator: Task completion evaluation
 * - Executor: Executes tasks directly with Reporter for progress updates
 * - TaskController: Unified controller for Evaluate → Execute → Repeat pattern
 *
 * Complete Workflow:
 * Flow 1: User request → Pilot (with deep-task skill) → Task.md
 * Flow 2: Task.md → TaskController → Evaluator → Executor → ...
 *
 * Evaluation-Execution Flow:
 * - Evaluator assesses task completion and identifies missing items
 * - Executor executes tasks directly with a single pseudo-subtask
 * - No intermediate planning layer - direct execution for faster response
 * - Real-time streaming of agent messages for immediate user feedback
 *
 * TaskController (Issue #283):
 * - Replaces DialogueOrchestrator + IterationBridge
 * - Single point of state management
 * - File-based completion detection (final_result.md)
 */

// Core agents
export { Evaluator } from '../agents/evaluator.js';

// Task Controller (Issue #283 - replaces DialogueOrchestrator + IterationBridge)
export {
  TaskController,
  type TaskControllerConfig,
} from './task-controller.js';

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

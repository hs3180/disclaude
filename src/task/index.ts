/**
 * Agent module exports.
 *
 * Architecture (Issue #283 - Simplified Reflection Pattern):
 * - Pilot: Handles user messages with deep-task skill for Task.md creation
 * - Evaluator: Task completion evaluation
 * - Executor: Executes tasks directly with Reporter for progress updates
 * - TaskController: Unified iterative task execution controller
 *
 * Complete Workflow:
 * Flow 1: User request → Pilot (with deep-task skill) → Task.md
 * Flow 2: Task.md → TaskController (Evaluate → Execute → Repeat) → ...
 *
 * TaskController Flow (Issue #283):
 * - Evaluator assesses task completion and writes evaluation.md
 * - Executor executes tasks and writes execution.md
 * - Loop continues until final_result.md detected or max iterations
 * - File-based communication - no JSON parsing
 *
 * Session Management:
 * - TaskController manages iteration state
 * - Each iteration creates fresh agent instances
 * - Completion detected via final_result.md presence
 */

// Core agents
export { Evaluator } from '../agents/evaluator.js';

// Task Controller (Issue #283 - replaces DialogueOrchestrator + IterationBridge)
export {
  TaskController,
  type TaskControllerConfig,
} from './task-controller.js';

// Legacy exports (deprecated - will be removed)
export {
  DialogueOrchestrator,
  type DialogueOrchestratorConfig,
} from './dialogue-orchestrator.js';

export {
  IterationBridge,
  type IterationBridgeConfig,
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

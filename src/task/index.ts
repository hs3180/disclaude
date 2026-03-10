/**
 * Agent module exports.
 *
 * Architecture (Evaluation-Execution):
 * - Pilot: Handles user messages with deep-task skill for Task.md creation
 * - SkillAgent: Generic agent that executes skills from markdown files (Issue #413)
 *
 * Complete Workflow:
 * Flow 1: User request → Pilot (with deep-task skill) → Task.md
 * Flow 2: Task.md → Schedule-driven task scanner → ...
 *
 * Evaluation-Execution Flow:
 * - SkillAgent with evaluator/SKILL.md assesses task completion
 * - SkillAgent with executor/SKILL.md executes tasks
 * - No intermediate planning layer - direct execution for faster response
 * - Real-time streaming of agent messages for immediate user feedback
 *
 * Refactored (Issue #283): Uses ReflectionController instead of DialogueOrchestrator.
 * Simplified (Issue #413): Uses SkillAgent instead of Evaluator/Executor classes.
 * Refactored (Issue #1309): Schedule-driven task scanner replaces ReflectionController.
 */

// SkillAgent (Issue #413)
export { SkillAgent, type SkillAgentExecuteOptions } from '../agents/skill-agent.js';

// Supporting modules
export { DialogueMessageTracker } from './dialogue-message-tracker.js';
export { parseBaseToolName, isUserFeedbackTool } from './mcp-utils.js';

// Context MCP tools
export {
  feishuContextTools,
  send_message,
  send_file,
} from '../mcp/feishu-context-mcp.js';

// Note: task_done has been removed - completion is now detected via final_result.md

// Utility
export { extractText } from '../utils/sdk.js';

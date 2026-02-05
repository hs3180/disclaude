/**
 * Agent module exports.
 *
 * Architecture:
 * - Planner: Task initialization - creates Task.md with metadata
 * - Manager: Task evaluation + user communication
 * - Worker: Task execution with full tool access
 * - AgentDialogueBridge: Manages prompt-based dialogue between agents
 *
 * Complete Workflow:
 * Flow 1: User request → Planner → Task.md (metadata + original request)
 * Flow 2: Task.md → Worker ↔ Manager → ...
 *
 * Session Management:
 * - Bridge internally manages sessions per messageId
 * - SDK's native resume parameter handles session persistence
 */

// Core agents
export { Planner } from './planner.js';
export { Manager } from './manager.js';
export { Worker } from './worker.js';

// Bridges
export {
  AgentDialogueBridge,
  type DialogueBridgeConfig,
} from './dialogue-bridge.js';

// Feishu context MCP tools
export {
  feishuContextTools,
  send_user_feedback,
  send_user_card,
  send_file_to_feishu,
  task_done,
  finalize_task_definition,
  type TaskDefinitionDetails,
} from '../mcp/feishu-context-mcp.js';

// Utility
export { extractText } from './manager.js';

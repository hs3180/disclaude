/**
 * Agent module exports.
 *
 * Architecture:
 * - InteractionAgent: Task initialization - creates Task.md with metadata
 * - OrchestrationAgent: Task evaluation + user communication
 * - ExecutionAgent: Task execution with full tool access
 * - AgentDialogueBridge: Manages prompt-based dialogue between agents
 *
 * Complete Workflow:
 * Flow 1: User request → InteractionAgent → Task.md (metadata + original request)
 * Flow 2: Task.md → ExecutionAgent ↔ OrchestrationAgent → ...
 *
 * Session Management:
 * - Bridge internally manages sessions per messageId
 * - SDK's native resume parameter handles session persistence
 */

// Core agents
export { InteractionAgent } from './interaction-agent.js';
export { OrchestrationAgent } from './orchestration-agent.js';
export { ExecutionAgent } from './execution-agent.js';

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
export { extractText } from './orchestration-agent.js';

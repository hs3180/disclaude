/**
 * Task Skill MCP Tools - In-process tools for task skill execution.
 *
 * This module provides `start_dialogue` tool that allows task skill (Pilot)
 * to trigger the background Dialogue phase (Evaluator → Executor → Reporter).
 *
 * Key Design:
 * - Tool is ONLY available to task skill (via allowed-tools in SKILL.md)
 * - Tool returns immediately after starting background task (fire-and-forget)
 * - Task Flow sends its own messages to Feishu (bypasses Pilot)
 * - Uses a callback registry pattern to access TaskFlowOrchestrator
 *
 * Usage:
 * - User: "帮我重构认证模块"
 * - Pilot → task skill → Pilot creates Task.md
 * - Pilot calls start_dialogue → TaskFlowOrchestrator starts in background
 * - User sees: Task.md content + background task running
 */

import { createLogger } from '../utils/logger.js';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';

const logger = createLogger('TaskSkillMCP');

/**
 * Callback registry for accessing TaskFlowOrchestrator.
 *
 * Called by FeishuBot during initialization to register orchestrator.
 * The start_dialogue tool retrieves orchestrator from this registry.
 */
let orchestratorInstance: TaskFlowOrchestrator | null = null;

/**
 * Register TaskFlowOrchestrator instance.
 * Called by FeishuBot during initialization.
 */
export function setTaskFlowOrchestrator(orchestrator: TaskFlowOrchestrator): void {
  orchestratorInstance = orchestrator;
  logger.info('TaskFlowOrchestrator registered for task skill');
}

/**
 * Get the registered TaskFlowOrchestrator.
 * @throws Error if not registered
 */
function getTaskFlowOrchestrator(): TaskFlowOrchestrator {
  if (!orchestratorInstance) {
    throw new Error('TaskFlowOrchestrator not registered. Call setTaskFlowOrchestrator() first.');
  }
  return orchestratorInstance;
}

/**
 * Helper to create a successful tool result.
 */
function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Tool: start_dialogue
 *
 * Starts the Dialogue phase (Evaluator → Executor loop) after Pilot creates Task.md.
 * This tool should ONLY be called by task skill (Pilot).
 *
 * The Dialogue phase will:
 * - Read Task.md created by Pilot
 * - Run Evaluator → Executor loop until completion
 * - Send completion notification via Reporter
 * - All output bypasses Pilot, going directly to Feishu
 *
 * Returns immediately after starting (fire-and-forget pattern).
 *
 * **Workflow**:
 * - Pilot creates Task.md → Pilot calls start_dialogue → Dialogue starts in background
 * - Pilot completes → User sees "Task.md created"
 * - Dialogue completes → User receives completion notification
 *
 * **Parameters**:
 * - messageId: The message ID for tracking (use your context messageId)
 * - chatId: The Feishu chat ID (use your context chatId)
 *
 * **DO NOT** call this tool multiple times for the same task.
 */
export const startDialogueTool = tool(
  'start_dialogue',
  `Start background Dialogue phase after Task.md is created.

**IMPORTANT**: This tool should ONLY be used by task skill (Pilot).

When you call this tool:
1. Task.md should already be created via Write tool
2. The Dialogue phase (Evaluator → Executor → Reporter) starts in background
3. User will receive progress updates and completion notification directly
4. You can continue responding to other messages

**Workflow**:
- Pilot creates Task.md → You call start_dialogue → Dialogue runs in background
- Pilot completes → User sees "Task.md created" + "Dialogue started"
- Dialogue completes → User receives completion notification

**Parameters**:
- messageId: Message ID for tracking (use your context messageId)
- chatId: Feishu chat ID (use your context chatId)

DO NOT call this tool multiple times for the same task.`,
  {
    messageId: z.string().describe('Message ID for tracking (use your context messageId)'),
    chatId: z.string().describe('Feishu chat ID (use your context chatId)'),
  },
  async ({ messageId, chatId }) => {
    try {
      logger.info({ chatId, messageId }, 'start_dialogue called by task skill');

      // Get orchestrator
      const orchestrator = getTaskFlowOrchestrator();

      // Start dialogue phase in background (fire-and-forget)
      // The orchestrator handles all dialogue execution and messaging
      await orchestrator.executeDialoguePhase(chatId, messageId, '');

      logger.info({ chatId, messageId }, 'Dialogue phase started in background');

      return toolSuccess('✅ Dialogue phase started in background. User will be notified when complete.');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, chatId }, 'start_dialogue failed');

      // Return as soft error (not isError) to allow agent to continue and retry
      // Include detailed error info for agent self-correction
      return toolSuccess(`⚠️ Failed to start dialogue: ${errorMessage}\n\nPlease check:\n1. Task.md file exists and is valid\n2. Message ID and Chat ID are correct\n3. System is properly initialized`);
    }
  }
);

/**
 * SDK MCP Server for Task Skill tools.
 *
 * **Lifecycle**:
 * - Module-level singleton created once at process startup
 * - Persists for lifetime of application
 * - Tools are ONLY available to agents that have them in allowed-tools
 *
 * **Usage**:
 * Add this to `mcpServers` SDK option when creating queries:
 * ```typescript
 * query({
 *   prompt: "...",
 *   options: {
 *     mcpServers: {
 *       'task-skill': taskSkillSdkMcpServer,
 *     },
 *   },
 * })
 * ```
 */
export const taskSkillSdkMcpServer = createSdkMcpServer({
  name: 'task-skill',
  version: '1.0.0',
  tools: [startDialogueTool],
});

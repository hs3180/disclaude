/**
 * A2A MCP Tool - Inline MCP tool for Agent-to-Agent task delegation.
 *
 * Issue #3334: Provides the `enqueue_task` tool that allows ChatAgents
 * to delegate tasks to project-bound agents via A2A messaging.
 *
 * Architecture:
 * ```
 * ChatAgent calls enqueue_task(projectKey, payload, priority)
 *   → MCP tool handler → A2ARouter.enqueueTask(fromChatId, ...)
 *     → Anti-recursion check
 *     → Rate limit check
 *     → Create A2AMessage
 *     → Route to project-bound agent
 * ```
 *
 * @module mcp-server/a2a-mcp
 */

import { z } from 'zod';
import { getProvider, createLogger, type SdkInlineToolDefinition, type A2ARouter } from '@disclaude/core';

const logger = createLogger('a2a-mcp');

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Current A2A router instance (set during initialization).
 * Undefined until setA2ARouter is called.
 */
let a2aRouter: A2ARouter | undefined;

/**
 * Current chatId context (set per-agent during MCP server creation).
 */
let currentChatId: string | undefined;

/**
 * Set the A2A router instance for tool handlers.
 * Called once during application initialization.
 */
export function setA2ARouter(router: A2ARouter): void {
  a2aRouter = router;
}

/**
 * Set the current chatId context for the tool handler.
 * This is the chatId of the agent that owns the MCP server.
 */
export function setA2AChatId(chatId: string): void {
  currentChatId = chatId;
}

/**
 * A2A tool definitions for inline MCP server.
 */
export const a2aToolDefinitions: SdkInlineToolDefinition[] = [
  {
    name: 'enqueue_task',
    description: `Delegate a task to a project-bound agent via A2A (Agent-to-Agent) messaging.

The task will be processed asynchronously by the target project's agent.
You will receive a confirmation immediately — the result will be delivered
to the project agent's bound chat.

## Safety Mechanisms
- **Anti-recursion**: Cannot delegate to your own project (same chatId)
- **Rate limiting**: Max 10 messages per minute per source agent
- **Source traceability**: Your chatId is recorded for audit

## Parameters
- **projectKey**: Target project identifier (e.g., "owner/repo")
- **payload**: Task instruction for the target agent
- **priority**: Optional priority — "low", "normal" (default), or "high"

## Example
\`\`\`json
{
  "projectKey": "hs3180/disclaude",
  "payload": "Check for new issues and triage them",
  "priority": "normal"
}
\`\`\``,
    parameters: z.object({
      projectKey: z.string().describe('Target project identifier (e.g., "owner/repo")'),
      payload: z.string().describe('Task instruction for the target agent'),
      priority: z.enum(['low', 'normal', 'high']).optional().describe('Task priority (default: "normal")'),
    }),
    handler: async ({ projectKey, payload, priority }: {
      projectKey: string;
      payload: string;
      priority?: 'low' | 'normal' | 'high';
    }) => {
      if (!a2aRouter) {
        return toolError('A2A router is not initialized. Agent-to-Agent delegation is not available.');
      }

      const fromChatId = currentChatId;
      if (!fromChatId) {
        return toolError('A2A chatId context is not set. Cannot determine source agent.');
      }

      try {
        const result = await a2aRouter.enqueueTask(
          fromChatId,
          projectKey,
          payload,
          priority ?? 'normal',
        );

        if (result.success) {
          logger.info({ fromChatId, projectKey, messageId: result.messageId }, 'A2A task enqueued via MCP tool');
          return toolSuccess(result.message);
        } else {
          return toolError(result.message);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMsg, fromChatId, projectKey }, 'A2A enqueue_task failed');
        return toolError(`Failed to enqueue task: ${errorMsg}`);
      }
    },
  },
];

/**
 * Create an inline MCP server for A2A tools.
 */
export function createA2aMcpServer(): unknown {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'a2a-mcp',
    version: '1.0.0',
    tools: a2aToolDefinitions,
  });
}

/**
 * A2A MCP Tools — Agent-to-Agent task delegation tools (Issue #3334).
 *
 * Provides the `enqueue_task` MCP tool that ChatAgents can invoke to
 * delegate work to another project-bound agent.
 *
 * Safety mechanisms are provided by the A2ARouter:
 * - Anti-recursion: Agent cannot enqueue to its own project
 * - Rate limiting: Max N messages per time window
 * - Source traceability: fromChatId recorded in A2AMessage
 * - Non-blocking: Returns immediately with confirmation
 *
 * @see Issue #3334 (Phase 4: A2A & Signal)
 * @module mcp-server/a2a-mcp
 */

import { z } from 'zod';
import { getProvider, type SdkInlineToolDefinition } from '@disclaude/core';

// ============================================================================
// Singleton A2ARouter Reference
// ============================================================================

/**
 * A2ARouter instance — set during primary node initialization.
 *
 * The A2ARouter is initialized in the primary node with references to
 * the MessageRouter and ProjectLookup. The MCP tool handler accesses
 * it via this singleton reference.
 */
let a2aRouter: import('@disclaude/core').A2ARouter | null = null;

/**
 * Initialize the A2A router singleton.
 *
 * Called during primary node startup to wire the A2ARouter
 * to the MessageRouter and ProjectLookup.
 *
 * @param router - A2ARouter instance with enqueue callback configured
 */
export function initA2aRouter(router: import('@disclaude/core').A2ARouter): void {
  a2aRouter = router;
}

/**
 * Get the A2A router singleton. Returns null if not initialized.
 */
export function getA2aRouter(): import('@disclaude/core').A2ARouter | null {
  return a2aRouter;
}

// ============================================================================
// Tool Response Helpers
// ============================================================================

function toolSuccess(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

// ============================================================================
// Tool Definitions
// ============================================================================

/**
 * Zod schema for enqueue_task parameters.
 */
const enqueueTaskSchema = z.object({
  fromChatId: z.string().describe(
    'Your current chatId (the chat this agent is bound to). Used for anti-recursion protection and traceability.'
  ),
  projectKey: z.string().describe(
    'Target project key (e.g., "owner/repo"). The project must have a bound agent.'
  ),
  payload: z.string().describe(
    'Task instruction text. The target agent will process this as input.'
  ),
  priority: z.enum(['low', 'normal', 'high']).optional().describe(
    'Message priority. Higher-priority messages are processed first when the target agent is busy. Default: "normal".'
  ),
});

/**
 * Inline tool definition for `enqueue_task`.
 *
 * This tool allows a ChatAgent to delegate a task to another project-bound
 * ChatAgent via A2A messaging. The tool:
 * 1. Validates parameters
 * 2. Checks anti-recursion (cannot delegate to self)
 * 3. Checks rate limits
 * 4. Creates an A2AMessage and routes it via the MessageRouter
 * 5. Returns immediately (non-blocking)
 */
export const a2aToolDefinitions: SdkInlineToolDefinition[] = [
  {
    name: 'enqueue_task',
    description: `Delegate a task to another project-bound agent (Agent-to-Agent / A2A messaging).

Use this tool when you need to delegate work to a different project's agent. The target agent processes the task asynchronously in its own chat.

## Parameters
- **fromChatId**: Your current chatId (for safety checks and traceability)
- **projectKey**: Target project key (e.g., "owner/repo")
- **payload**: Task instruction text for the target agent
- **priority**: Optional priority ("low", "normal", "high"). Default: "normal"

## Safety Mechanisms
- **Anti-recursion**: Cannot delegate to your own project (same chatId)
- **Rate limiting**: Max messages per time window to prevent abuse
- **Non-blocking**: Returns immediately, target agent processes asynchronously

## Example
\`\`\`json
{
  "fromChatId": "oc_my_chat_123",
  "projectKey": "hs3180/disclaude",
  "payload": "Triage all open issues and apply labels",
  "priority": "high"
}
\`\`\`

## When to Use
- Delegating repository maintenance tasks to a project-specific agent
- Cross-project coordination (agent for repo A triggers work in repo B)
- Task escalation to a more capable project-bound agent

## When NOT to Use
- If you need a synchronous response (this is fire-and-forget)
- If the target is your own project (use direct processing instead)`,
    parameters: enqueueTaskSchema,
    handler: async (params: z.infer<typeof enqueueTaskSchema>) => {
      const { fromChatId, projectKey, payload, priority } = params;

      if (!a2aRouter) {
        return toolError('A2A messaging is not available. The A2A router has not been initialized.');
      }

      try {
        const result = await a2aRouter.enqueueTask({
          fromChatId,
          projectKey,
          payload,
          priority,
        });
        return result.success ? toolSuccess(result.message) : toolError(result.message);
      } catch (error) {
        return toolError(
          `enqueue_task failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
  },
];

// ============================================================================
// MCP Server Factory
// ============================================================================

/**
 * Create an inline MCP server providing A2A tools.
 *
 * The server includes the `enqueue_task` tool for Agent-to-Agent delegation.
 */
export function createA2aMcpServer() {
  return getProvider().createMcpServer({
    type: 'inline',
    name: 'a2a-mcp',
    version: '1.0.0',
    tools: a2aToolDefinitions,
  });
}

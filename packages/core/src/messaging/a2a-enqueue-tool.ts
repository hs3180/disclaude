/**
 * A2A enqueue_task tool — enables ChatAgents to delegate tasks to project-bound agents.
 *
 * This module provides:
 * - `createA2AEnqueueHandler()` — Creates the handler function for the enqueue_task tool
 * - `createA2AEnqueueToolDefinition()` — Creates the full tool definition for MCP registration
 *
 * The tool is non-blocking: it returns immediately after routing the A2A NonUserMessage.
 * The target agent processes the task asynchronously and replies to its bound chat.
 *
 * Safety features:
 * - Anti-recursion: agent cannot enqueue tasks to its own project
 * - Rate limiting: max configurable A2A messages per source per time window
 * - Source traceability: NonUserMessage.source records originating chatId
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 */

import { randomUUID } from 'node:crypto';
import { createLogger, type Logger } from '../utils/logger.js';
import type { A2AConfig, A2AEnqueueResult, EnqueueTaskParams } from './a2a-types.js';
import { A2ARateLimiter } from './a2a-rate-limiter.js';
import type { NonUserMessage, NonUserMessagePriority } from './non-user-message.js';
import type { ProjectResolver } from './non-user-message-router.js';

const defaultLogger = createLogger('A2AEnqueue');

// ============================================================================
// A2A Enqueue Handler
// ============================================================================

/**
 * Creates a handler function for the `enqueue_task` tool.
 *
 * The handler encapsulates all A2A logic: anti-recursion check, rate limiting,
 * message creation, and routing via NonUserMessageRouter.
 *
 * @param config - A2A configuration (resolver, router, rate limit)
 * @param sourceChatId - The chatId of the calling agent (for anti-recursion and traceability)
 * @returns Async handler function for enqueue_task
 */
export function createA2AEnqueueHandler(
  config: A2AConfig,
  sourceChatId: string,
  logger?: Logger,
): (params: EnqueueTaskParams) => Promise<A2AEnqueueResult> {
  const rateLimiter = new A2ARateLimiter(config.rateLimit);
  const source = `chat:${sourceChatId}`;
  const log = logger ?? defaultLogger;

  return (params: EnqueueTaskParams): Promise<A2AEnqueueResult> => {
    // Step 1: Anti-recursion check
    // Resolve target projectKey → chatId, compare with source
    const recursionError = checkAntiRecursion(
      config.projectResolver,
      params.projectKey,
      sourceChatId,
    );
    if (recursionError) {
      return { ok: false, error: recursionError };
    }

    // Step 2: Rate limiting
    if (!rateLimiter.check(source)) {
      return {
        ok: false,
        error: `Rate limit exceeded for source ${source}. Too many A2A messages within the time window.`,
      };
    }

    // Step 3: Pre-flight validation — check project exists and router not disposed
    const targetChatId = config.projectResolver.resolve(params.projectKey);
    if (!targetChatId) {
      return { ok: false, error: `Project not found: ${params.projectKey}` };
    }

    // Step 4: Create NonUserMessage with type 'a2a'
    const messageId = `a2a-${randomUUID()}`;
    const priority: NonUserMessagePriority = params.priority ?? 'normal';

    const message: NonUserMessage = {
      id: messageId,
      type: 'a2a',
      source,
      projectKey: params.projectKey,
      payload: params.payload,
      priority,
      createdAt: new Date().toISOString(),
    };

    // Step 5: Route via NonUserMessageRouter (non-blocking: fire-and-forget)
    // The tool returns immediately. The router handles queuing and delivery asynchronously.
    config.router.route(message).catch((err) => {
      log.error({ err, messageId, projectKey: params.projectKey }, 'A2A route failed');
    });

    return {
      ok: true,
      messageId,
      targetProject: params.projectKey,
    };
  };
}

// ============================================================================
// Anti-Recursion Check
// ============================================================================

/**
 * Check if a target projectKey resolves to the source chatId.
 * Prevents an agent from enqueuing tasks to itself.
 *
 * @returns Error message if recursion detected, null otherwise
 */
function checkAntiRecursion(
  projectResolver: ProjectResolver,
  targetProjectKey: string,
  sourceChatId: string,
): string | null {
  const targetChatId = projectResolver.resolve(targetProjectKey);
  if (targetChatId && targetChatId === sourceChatId) {
    return `Anti-recursion: cannot enqueue task to own project (projectKey: ${targetProjectKey}, chatId: ${targetChatId})`;
  }
  return null;
}

// ============================================================================
// Tool Definition (for MCP registration)
// ============================================================================

/**
 * Tool description for the `enqueue_task` tool.
 * Used when registering the tool with the SDK's MCP server.
 */
export const ENQUEUE_TASK_DESCRIPTION = `Delegate a task to a project-bound agent for asynchronous processing.

This tool enables Agent-to-Agent (A2A) task delegation. You can enqueue a task for another project's agent to process. The task is non-blocking — you get an immediate confirmation, and the target agent will process it and reply to its own bound chat.

Usage examples:
- Delegate issue triage: "triage all open issues and create a summary"
- Cross-project coordination: trigger work in another repository
- Task escalation: hand off complex analysis to a dedicated project agent

Safety:
- You cannot enqueue tasks to your own project (anti-recursion)
- Rate limited to prevent flooding
- Your chatId is recorded as the source for traceability`;

/**
 * JSON Schema for enqueue_task tool parameters.
 */
export const ENQUEUE_TASK_PARAMETERS = {
  type: 'object' as const,
  properties: {
    projectKey: {
      type: 'string' as const,
      description: 'Target project key (e.g., "hs3180/disclaude")',
    },
    payload: {
      type: 'string' as const,
      description: 'Task instruction for the target agent',
    },
    priority: {
      type: 'string' as const,
      enum: ['low', 'normal', 'high'],
      description: 'Priority level (default: "normal")',
    },
  },
  required: ['projectKey', 'payload'] as const,
};

/**
 * Query execution logic for BaseAgent.
 *
 * Contains query/stream execution functions and message formatting utilities.
 * Extracted from base-agent.ts as part of Issue #2345 Phase 2.
 *
 * @module agents/base-agent-query
 */

import {
  type AcpClient,
  type AgentMessage as SdkAgentMessage,
  type StreamingUserMessage,
  type AgentQueryOptions,
  type QueryHandle,
} from '../sdk/index.js';
import { AppError, ErrorCategory, formatError } from '../utils/error-handler.js';
import type { Logger } from '../utils/logger.js';
import type { AgentMessage } from '../types/index.js';
import type { AgentProvider } from './types.js';
import { toAcpSessionOptions, convertToLegacyFormat } from './base-agent-acp.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Result from iterator yield.
 */
export interface IteratorYieldResult {
  /** Parsed message (legacy format for compatibility) */
  parsed: {
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
    sessionId?: string;
  };
  /** SDK Agent message */
  raw: SdkAgentMessage;
}

/**
 * Result from queryStream with streaming input.
 * Includes QueryHandle for lifecycle control (close/cancel).
 */
export interface QueryStreamResult {
  /** The QueryHandle for lifecycle control */
  handle: QueryHandle;
  /** AsyncGenerator yielding parsed messages */
  iterator: AsyncGenerator<IteratorYieldResult>;
}

/**
 * Context interface for query functions.
 * Provides agent-specific dependencies needed for query execution.
 */
export interface QueryContext {
  /** ACP client for session management */
  acpClient: AcpClient;
  /** Logger instance */
  logger: Logger;
  /** Agent provider */
  provider: AgentProvider;
  /** Ensure ACP client is connected */
  ensureClientConnected(): Promise<void>;
  /** Get workspace directory */
  getWorkspaceDir(): string;
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Execute a one-shot query using ACP Client.
 *
 * Creates a new ACP session, sends a single prompt, yields messages,
 * and cleans up the session.
 *
 * For task-based agents (Evaluator, Executor) that use
 * static prompts. Input is a string or message array.
 *
 * @param ctx - Agent query context
 * @param input - Static prompt string or message array
 * @param options - AgentQueryOptions
 * @yields IteratorYieldResult with parsed and raw message
 */
export async function* executeQueryOnce(
  ctx: QueryContext,
  input: string | unknown[],
  options: AgentQueryOptions,
): AsyncGenerator<IteratorYieldResult> {
  // Ensure client is connected
  await ctx.ensureClientConnected();

  // Create ACP session
  const session = await ctx.acpClient.createSession(
    options.cwd ?? ctx.getWorkspaceDir(),
    toAcpSessionOptions(options),
  );

  // Convert input to ACP prompt format
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const prompt = [{ type: 'text' as const, text }];

  try {
    // Send prompt and yield messages
    for await (const message of ctx.acpClient.sendPrompt(session.sessionId, prompt)) {
      const parsed = convertToLegacyFormat(message);

      // Log message with full details for debugging
      ctx.logger.debug({
        provider: ctx.provider,
        messageType: parsed.type,
        contentLength: parsed.content?.length || 0,
        toolName: parsed.metadata?.toolName,
        rawMessage: message,
      }, 'ACP message received');

      yield { parsed, raw: message };
    }
  } finally {
    // Log session completion for debugging resource lifecycle
    ctx.logger.debug({ sessionId: session.sessionId }, 'queryOnce session completed');
  }
}

/**
 * Execute a streaming query using ACP Client.
 *
 * Creates a single ACP session for the conversation lifetime.
 * Each message from the input generator is sent as a separate prompt
 * on the same session, preserving conversation context.
 *
 * For conversational agents (ChatAgent) that use dynamic input generators.
 *
 * @param ctx - Agent query context
 * @param input - AsyncGenerator yielding user messages
 * @param options - AgentQueryOptions
 * @returns QueryStreamResult with handle and iterator
 */
export function createStreamQuery(
  ctx: QueryContext,
  input: AsyncGenerator<StreamingUserMessage>,
  options: AgentQueryOptions,
): QueryStreamResult {
  // Session created lazily when iterator is consumed
  let sessionPromise: Promise<string> | null = null;
  let sessionId: string | undefined;
  let cancelled = false;
  let closed = false;
  let pendingCancel = false; // Track cancel requests during session creation

  function ensureSession(): Promise<string> {
    if (sessionId) {
      return Promise.resolve(sessionId);
    }

    if (!sessionPromise) {
      sessionPromise = ctx.ensureClientConnected()
        .then(() => ctx.acpClient.createSession(
          options.cwd ?? ctx.getWorkspaceDir(),
          toAcpSessionOptions(options),
        ))
        .then((session) => {
          const { sessionId: sid } = session;
          sessionId = sid;
          // If cancel was requested during session creation, execute it now
          if (pendingCancel) {
            ctx.acpClient.cancelPrompt(sid).catch(() => {});
          }
          return sid;
        });
    }

    return sessionPromise;
  }

  async function* wrappedIterator(): AsyncGenerator<IteratorYieldResult> {
    const sid = await ensureSession();

    try {
      for await (const msg of input) {
        if (cancelled || closed) {
          break;
        }

        // Convert StreamingUserMessage to ACP prompt format
        const text = typeof msg.message?.content === 'string'
          ? msg.message.content
          : JSON.stringify(msg.message?.content ?? '');

        const prompt = [{ type: 'text' as const, text }];

        // Send each message as a prompt on the same session
        for await (const acpMessage of ctx.acpClient.sendPrompt(sid, prompt)) {
          if (cancelled || closed) {
            break;
          }

          const parsed = convertToLegacyFormat(acpMessage);

          // Log message with full details for debugging
          ctx.logger.debug({
            provider: ctx.provider,
            messageType: parsed.type,
            contentLength: parsed.content?.length || 0,
            toolName: parsed.metadata?.toolName,
            rawMessage: acpMessage,
          }, 'ACP message received');

          yield { parsed, raw: acpMessage };
        }
      }
    } catch (err) {
      // Re-throw to let caller handle
      throw err;
    }
  }

  return {
    handle: {
      close: () => {
        closed = true;
      },
      cancel: () => {
        cancelled = true;
        if (sessionId) {
          ctx.acpClient.cancelPrompt(sessionId).catch((err) => {
            ctx.logger.warn({ err }, 'Failed to cancel prompt');
          });
        } else {
          // Session not created yet — flag to cancel once it's ready
          pendingCancel = true;
        }
      },
      get sessionId() {
        return sessionId;
      },
    },
    iterator: wrappedIterator(),
  };
}

// ============================================================================
// Formatting Functions
// ============================================================================

/**
 * Format parsed message as AgentMessage.
 *
 * Convenience method for subclasses.
 *
 * @param parsed - Parsed SDK message
 * @returns AgentMessage
 */
export function formatMessage(parsed: IteratorYieldResult['parsed']): AgentMessage {
  return {
    content: parsed.content,
    role: 'assistant',
    messageType: parsed.type as AgentMessage['messageType'],
    metadata: parsed.metadata as AgentMessage['metadata'],
  };
}

/**
 * Handle iterator error with proper logging and error wrapping.
 *
 * Creates AppError and returns an AgentMessage for yielding to caller.
 *
 * @param agentName - Name of the agent for error context
 * @param logger - Logger instance
 * @param error - The caught error
 * @param operation - Operation name for error message
 * @returns AgentMessage for yielding to caller
 */
export function handleIteratorError(
  agentName: string,
  logger: Logger,
  error: unknown,
  operation: string,
): AgentMessage {
  const agentError = new AppError(
    `${agentName} ${operation} failed`,
    ErrorCategory.SDK,
    undefined,
    {
      cause: error instanceof Error ? error : new Error(String(error)),
      context: { agent: agentName },
      retryable: true,
    }
  );
  logger.error({ err: formatError(agentError) }, `${operation} failed`);

  return {
    content: `❌ Error: ${error instanceof Error ? error.message : String(error)}`,
    role: 'assistant',
    messageType: 'error',
  };
}

/**
 * OpenAI ACP Server — bridges OpenAI Chat Completions API to ACP protocol.
 *
 * This module implements an ACP-compatible server that translates JSON-RPC
 * requests (received via stdin) into OpenAI API calls and streams responses
 * back as ACP session/update notifications (via stdout).
 *
 * ## Architecture
 *
 * ```
 * Disclaude AcpClient ←→ stdio ←→ OpenAI AcpServer ←→ OpenAI API
 * ```
 *
 * ## Protocol Mapping
 *
 * | ACP Method         | Action                                    |
 * |--------------------|-------------------------------------------|
 * | initialize         | Return server capabilities                |
 * | session/new        | Create session, return model info         |
 * | session/prompt     | Forward to OpenAI Chat Completions (stream)|
 * | session/cancel     | Abort ongoing API call                    |
 *
 * ## Usage
 *
 * ```bash
 * OPENAI_API_KEY=sk-... node -e 'import("./sdk/acp/openai-server.js").then(m => m.run())'
 * ```
 *
 * Or set `agent.acpCommand` in disclaude.config.yaml to point to this server.
 *
 * @module sdk/acp/openai-server
 */

import { createInterface } from 'node:readline';

// ============================================================================
// Types
// ============================================================================

/** JSON-RPC 2.0 request (received from client) */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result: unknown;
}

/** JSON-RPC 2.0 error response */
interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

/** JSON-RPC 2.0 notification */
interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type JsonRpcOutgoing = JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification;

/** Session state */
interface Session {
  sessionId: string;
  cwd: string;
  model: string;
  abortController: AbortController | null;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  return key;
}

function getBaseUrl(): string {
  return process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
}

function getModel(): string {
  return process.env.OPENAI_MODEL || DEFAULT_MODEL;
}

// ============================================================================
// JSON-RPC Helpers
// ============================================================================

function send(msg: JsonRpcOutgoing): void {
  process.stdout.write(`${JSON.stringify(msg)  }\n`);
}

function sendResponse(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function sendNotification(method: string, params: unknown): void {
  send({ jsonrpc: '2.0', method, params });
}

// ============================================================================
// OpenAI API Integration
// ============================================================================

/**
 * Extract text content from ACP prompt blocks.
 */
function extractPromptText(prompt: unknown): string {
  if (typeof prompt === 'string') {return prompt;}
  if (Array.isArray(prompt)) {
    return prompt
      .map((block: unknown) => {
        if (typeof block === 'string') {return block;}
        if (typeof block === 'object' && block !== null && 'text' in block) {
          return (block as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(prompt);
}

/**
 * Parse SSE (Server-Sent Events) stream from OpenAI API.
 * Yields content deltas as they arrive.
 */
async function* parseOpenAIStream(
  response: Response,
  abortSignal: AbortSignal,
): AsyncGenerator<{ type: 'content' | 'done'; content?: string; usage?: { inputTokens: number; outputTokens: number } }> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (abortSignal.aborted) {break;}

      const { done, value } = await reader.read();
      if (done) {break;}

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {continue;} // skip empty/comments

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: 'content', content: delta.content };
            }
            // Check for finish_reason with usage
            if (parsed.choices?.[0]?.finish_reason === 'stop' && parsed.usage) {
              yield {
                type: 'done',
                usage: {
                  inputTokens: parsed.usage.prompt_tokens ?? 0,
                  outputTokens: parsed.usage.completion_tokens ?? 0,
                },
              };
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: 'done' };
}

/**
 * Call OpenAI Chat Completions API with streaming and emit ACP notifications.
 */
async function handlePrompt(
  session: Session,
  params: Record<string, unknown>,
): Promise<{ stopReason: string; usage: { inputTokens: number; outputTokens: number } }> {
  const {prompt} = params;
  const text = extractPromptText(prompt);

  const abortController = new AbortController();
  session.abortController = abortController;

  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const response = await fetch(`${getBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getApiKey()}`,
      },
      body: JSON.stringify({
        model: session.model,
        messages: [{ role: 'user', content: text }],
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    // Stream response chunks as ACP session/update notifications
    for await (const chunk of parseOpenAIStream(response, abortController.signal)) {
      if (abortController.signal.aborted) {break;}

      if (chunk.type === 'content' && chunk.content) {
        // Emit ACP agent_message_chunk notification
        sendNotification('session/update', {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: chunk.content },
          },
        });
      }

      if (chunk.type === 'done') {
        if (chunk.usage) {
          ({ inputTokens, outputTokens } = chunk.usage);
        }
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } };
    }
    throw err;
  } finally {
    session.abortController = null;
  }

  return {
    stopReason: 'end_turn',
    usage: { inputTokens, outputTokens },
  };
}

// ============================================================================
// Session Management
// ============================================================================

const sessions = new Map<string, Session>();

function createSession(params: Record<string, unknown>): Session {
  const sessionId = `openai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const cwd = (params.cwd as string) || process.cwd();
  const model = getModel();

  const session: Session = {
    sessionId,
    cwd,
    model,
    abortController: null,
  };

  sessions.set(sessionId, session);
  return session;
}

// ============================================================================
// ACP Protocol Handlers
// ============================================================================

function handleInitialize(id: number | string | null, _params?: Record<string, unknown>): void {
  sendResponse(id, {
    protocolVersion: 1,
    capabilities: {},
  });
}

function handleSessionNew(id: number | string | null, params?: Record<string, unknown>): void {
  if (!params) {
    sendError(id, -32602, 'session/new requires params');
    return;
  }

  const session = createSession(params);

  sendResponse(id, {
    sessionId: session.sessionId,
    models: {
      availableModels: [{ modelId: session.model }],
      currentModelId: session.model,
    },
  });
}

async function handleSessionPrompt(id: number | string | null, params?: Record<string, unknown>): Promise<void> {
  if (!params) {
    sendError(id, -32602, 'session/prompt requires params');
    return;
  }

  const sessionId = params.sessionId as string;
  const session = sessions.get(sessionId);
  if (!session) {
    sendError(id, -32602, `Session not found: ${sessionId}`);
    return;
  }

  try {
    const result = await handlePrompt(session, params);
    sendResponse(id, {
      stopReason: result.stopReason,
      usage: result.usage,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(id, -32603, `Prompt failed: ${message}`);
  }
}

function handleSessionCancel(id: number | string | null, params?: Record<string, unknown>): void {
  if (!params) {
    sendError(id, -32602, 'session/cancel requires params');
    return;
  }

  const sessionId = params.sessionId as string;
  const session = sessions.get(sessionId);
  if (session?.abortController) {
    session.abortController.abort();
  }

  sendResponse(id, {});
}

// ============================================================================
// Message Router
// ============================================================================

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      handleInitialize(id ?? null, params as Record<string, unknown> | undefined);
      break;
    case 'session/new':
      handleSessionNew(id ?? null, params as Record<string, unknown> | undefined);
      break;
    case 'session/prompt':
      await handleSessionPrompt(id ?? null, params as Record<string, unknown> | undefined);
      break;
    case 'session/cancel':
      handleSessionCancel(id ?? null, params as Record<string, unknown> | undefined);
      break;
    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// ============================================================================
// Entry Point
// ============================================================================

/**
 * Run the OpenAI ACP Server.
 *
 * Reads JSON-RPC messages from stdin (NDJSON format), processes them,
 * and writes responses/notifications to stdout (NDJSON format).
 */
export function run(): void {
  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {return;}

    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — skip
      return;
    }

    // Handle message asynchronously
    handleMessage(msg).catch((err) => {
      if (msg.id !== undefined) {
        sendError(
          msg.id,
          -32603,
          `Internal error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  });

  rl.on('close', () => {
    // Abort all active sessions
    for (const session of sessions.values()) {
      session.abortController?.abort();
    }
    sessions.clear();
  });

  // Signal ready (stderr to avoid polluting JSON-RPC stdout)
  process.stderr.write('OpenAI ACP Server ready\n');
}

/**
 * OpenAI ACP Server - Bridge between ACP protocol and OpenAI API
 *
 * This module provides a standalone ACP server that translates ACP JSON-RPC
 * requests (over stdio) into OpenAI API calls, enabling OpenAI models
 * (GPT-4o, o3, etc.) to be used as Agent backends via the standard ACP protocol.
 *
 * ## Architecture
 *
 * ```
 * AcpClient (Disclaude)
 *    ↓ JSON-RPC over stdio (NDJSON)
 * OpenAI AcpServer (this module)
 *    ↓ HTTP/REST
 * OpenAI API (api.openai.com)
 * ```
 *
 * ## Usage
 *
 * This server is designed to be spawned as a child process by `AcpStdioTransport`.
 * It reads ACP JSON-RPC requests from stdin and writes responses to stdout.
 *
 * ```bash
 * OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4o node openai-acp-server.js
 * ```
 *
 * ## Environment Variables
 *
 * | Variable | Required | Description |
 * |----------|----------|-------------|
 * | OPENAI_API_KEY | Yes | OpenAI API key |
 * | OPENAI_MODEL | Yes | Model to use (e.g. gpt-4o, o3) |
 * | OPENAI_API_BASE_URL | No | API base URL (default: https://api.openai.com/v1) |
 *
 * ## Supported ACP Methods
 *
 * | Method | Status | Notes |
 * |--------|--------|-------|
 * | initialize | ✅ | Returns server capabilities |
 * | session/new | ✅ | Creates conversation context |
 * | session/prompt | ✅ | Streams responses via session/update |
 * | session/cancel | ✅ | Aborts in-progress requests |
 *
 * @module sdk/acp/openai-acp-server
 * @see Issue #1333
 */

import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

// ============================================================================
// Types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface SessionState {
  id: string;
  cwd: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  abortController: AbortController | null;
}

// ============================================================================
// Configuration
// ============================================================================

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const OPENAI_API_BASE_URL = process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1';

if (!OPENAI_API_KEY) {
  const errorResp: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'OPENAI_API_KEY environment variable is required' },
  };
  process.stdout.write(`${JSON.stringify(errorResp)}\n`);
  process.exit(1);
}

// ============================================================================
// State
// ============================================================================

const sessions = new Map<string, SessionState>();

// ============================================================================
// JSON-RPC Helpers
// ============================================================================

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function sendNotification(notification: JsonRpcNotification): void {
  process.stdout.write(`${JSON.stringify(notification)}\n`);
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function successResponse(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

// ============================================================================
// ACP Method Handlers
// ============================================================================

function handleInitialize(id: number | string, _params?: unknown): JsonRpcResponse {
  return successResponse(id, {
    protocolVersion: 1,
    serverCapabilities: {
      name: 'openai-acp-server',
      version: '0.1.0',
      provider: 'openai',
    },
  });
}

function handleSessionNew(id: number | string, params?: {
  cwd?: string;
  mcpServers?: unknown[];
  _meta?: unknown;
}): JsonRpcResponse {
  const sessionId = randomUUID();
  const session: SessionState = {
    id: sessionId,
    cwd: params?.cwd || process.cwd(),
    messages: [],
    abortController: null,
  };
  sessions.set(sessionId, session);

  return successResponse(id, {
    sessionId,
    models: {
      availableModels: [{ modelId: OPENAI_MODEL }],
      currentModelId: OPENAI_MODEL,
    },
  });
}

async function handleSessionPrompt(id: number | string, params?: {
  sessionId?: string;
  prompt?: Array<{ type: string; text?: string }>;
}): Promise<void> {
  const sessionId = params?.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    sendResponse(errorResponse(id, -32602, `Invalid session: ${sessionId}`));
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    sendResponse(errorResponse(id, -32602, `Session not found: ${sessionId}`));
    return;
  }

  // Extract text from prompt blocks
  const promptText = (params?.prompt || [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');

  if (!promptText) {
    sendResponse(errorResponse(id, -32602, 'Empty prompt'));
    return;
  }

  // Add user message to conversation
  session.messages.push({ role: 'user', content: promptText });

  // Create abort controller for this request
  const abortController = new AbortController();
  session.abortController = abortController;

  try {
    const response = await fetch(`${OPENAI_API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: session.messages,
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      sendResponse(errorResponse(id, -32603, `OpenAI API error (${response.status}): ${errorText.slice(0, 500)}`));
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      sendResponse(errorResponse(id, -32603, 'No response body from OpenAI'));
      return;
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    // Process SSE stream
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          continue;
        }
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          continue;
        }

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            // Send agent_message_chunk notification
            sendNotification({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: delta.content },
                },
              },
            });
          }
          // Capture usage if available
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens || 0;
            outputTokens = chunk.usage.completion_tokens || 0;
          }
        } catch {
          // Ignore malformed chunks
        }
      }
    }

    // Add assistant response to conversation history
    session.messages.push({ role: 'assistant', content: fullContent });

    // Send prompt result
    sendResponse(successResponse(id, {
      stopReason: 'end_turn',
      usage: { inputTokens, outputTokens },
    }));
  } catch (err) {
    if (abortController.signal.aborted) {
      sendResponse(errorResponse(id, -32603, 'Request cancelled'));
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sendResponse(errorResponse(id, -32603, `OpenAI request failed: ${message}`));
    }
  } finally {
    session.abortController = null;
  }
}

function handleSessionCancel(id: number | string, params?: { sessionId?: string }): JsonRpcResponse {
  const sessionId = params?.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    return errorResponse(id, -32602, `Invalid session: ${sessionId}`);
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return errorResponse(id, -32602, `Session not found: ${sessionId}`);
  }
  if (session.abortController) {
    session.abortController.abort();
  }

  return successResponse(id, {});
}

// ============================================================================
// Main Dispatch
// ============================================================================

async function handleMessage(request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;
  const reqId = id ?? 0;

  switch (method) {
    case 'initialize':
      sendResponse(handleInitialize(reqId, params));
      break;

    case 'session/new':
      sendResponse(handleSessionNew(reqId, params as Parameters<typeof handleSessionNew>[1]));
      break;

    case 'session/prompt':
      await handleSessionPrompt(reqId, params as Parameters<typeof handleSessionPrompt>[1]);
      break;

    case 'session/cancel':
      sendResponse(handleSessionCancel(reqId, params as Parameters<typeof handleSessionCancel>[1]));
      break;

    default:
      sendResponse(errorResponse(reqId, -32601, `Method not found: ${method}`));
  }
}

// ============================================================================
// Stdio Transport
// ============================================================================

const readline = createInterface({ input: process.stdin });

readline.on('line', async (line: string) => {
  if (!line.trim()) {
    return;
  }
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    await handleMessage(request);
  } catch {
    sendResponse(errorResponse(null, -32700, 'Parse error'));
  }
});

readline.on('close', () => {
  // Clean up all sessions
  for (const [_, session] of sessions) {
    if (session.abortController) {
      session.abortController.abort();
    }
  }
  sessions.clear();
});

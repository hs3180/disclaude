/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks.
 * Listens on HTTP port for prompt execution requests from Communication Node.
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Config } from '../config/index.js';
import { Pilot, type PilotCallbacks } from '../agents/pilot.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getExecNodeConfig, type ExecNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('ExecRunner');

/**
 * Request body for prompt execution.
 */
interface ExecuteRequestBody {
  chatId: string;
  prompt: string;
  messageId: string;
  senderOpenId?: string;
}

/**
 * Callback message types.
 */
interface CallbackMessage {
  chatId: string;
  type: 'text' | 'card' | 'file';
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
}

/**
 * Run Execution Node (Pilot Agent with HTTP server).
 *
 * Listens for prompt execution requests from Communication Node.
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runExecutionNode(config?: ExecNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getExecNodeConfig(globalArgs);

  // Use port from config or default to 3002
  const port = runnerConfig.port || 3002;
  const host = '0.0.0.0';

  logger.info({
    port,
    communicationUrl: runnerConfig.communicationUrl,
  }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log(`Mode: Execution (Pilot Agent + HTTP Server)`);
  console.log(`Port: ${port}`);
  console.log(`Communication URL: ${runnerConfig.communicationUrl}`);
  console.log();

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Track active executions by chatId for callback routing
  const activeCallbacks = new Map<string, (msg: CallbackMessage) => void>();

  // Create Pilot callbacks that route to the correct callback
  const createCallbacks = (chatId: string, callback: (msg: CallbackMessage) => void): PilotCallbacks => ({
    sendMessage: async (_, text: string) => {
      callback({ chatId, type: 'text', text });
    },
    sendCard: async (_, card: Record<string, unknown>, description?: string) => {
      callback({ chatId, type: 'card', card, text: description });
    },
    sendFile: async (_, filePath: string) => {
      callback({ chatId, type: 'file', filePath });
    },
  });

  // Create HTTP server for receiving execution requests
  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const path = url.pathname;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (req.method === 'POST' && path === '/execute') {
        // Handle prompt execution request
        const body = await readJsonBody<ExecuteRequestBody>(req);

        if (!body || !body.chatId || !body.prompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: chatId, prompt' }));
          return;
        }

        logger.info({ chatId: body.chatId, messageId: body.messageId }, 'Received execute request');

        // Create callback for this execution
        const callbackUrl = runnerConfig.communicationUrl;
        const sendCallback = async (msg: CallbackMessage) => {
          if (callbackUrl) {
            await httpPost(`${callbackUrl}/callback`, msg);
          }
        };

        // Create Pilot instance for this execution
        const pilot = new Pilot({
          apiKey: agentConfig.apiKey,
          model: agentConfig.model,
          apiBaseUrl: agentConfig.apiBaseUrl,
          isCliMode: true, // Blocking execution
          callbacks: createCallbacks(body.chatId, sendCallback),
        });

        // Execute the prompt
        try {
          await pilot.executeOnce(body.chatId, body.prompt, body.messageId, body.senderOpenId);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          const err = error as Error;
          logger.error({ err, chatId: body.chatId }, 'Execution failed');

          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      } else if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'execution' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error) {
      const err = error as Error;
      logger.error({ err, path }, 'Request handler error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  // Start server
  await new Promise<void>((resolve) => {
    server.listen(port, host, () => resolve());
  });

  logger.info({ port, host }, 'Execution Node listening');
  console.log('✓ Execution Node ready');
  console.log();
  console.log('Endpoints:');
  console.log('  POST /execute - Receive prompts from Communication Node');
  console.log('  GET  /health  - Health check');
  console.log();

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Execution Node...');
    console.log('\nShutting down Execution Node...');

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Read JSON body from request.
 */
async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * HTTP POST helper.
 */
async function httpPost(url: string, data: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const body = JSON.stringify(data);

    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      () => resolve()
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.write(body);
    req.end();
  });
}

// Re-export type for external use
export type { ExecNodeConfig };

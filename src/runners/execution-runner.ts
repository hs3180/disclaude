/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks.
 * Listens on WebSocket for prompt execution requests from Communication Node.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import { Config } from '../config/index.js';
import { Pilot, type PilotCallbacks } from '../agents/pilot.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getExecNodeConfig, type ExecNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('ExecRunner');

/**
 * WebSocket message types.
 */
interface PromptMessage {
  type: 'prompt';
  chatId: string;
  prompt: string;
  messageId: string;
  senderOpenId?: string;
}

interface FeedbackMessage {
  type: 'text' | 'card' | 'file' | 'done' | 'error';
  chatId: string;
  text?: string;
  card?: Record<string, unknown>;
  filePath?: string;
  error?: string;
}

/**
 * Run Execution Node (Pilot Agent with WebSocket server).
 *
 * Listens for prompt execution requests from Communication Node via WebSocket.
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runExecutionNode(config?: ExecNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getExecNodeConfig(globalArgs);

  // Use port from config or default to 3002
  const port = runnerConfig.port || 3002;
  const host = '0.0.0.0';

  logger.info({ port }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log(`Mode: Execution (Pilot Agent + WebSocket Server)`);
  console.log(`Port: ${port}`);
  console.log();

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Track active connections by chatId
  const activeConnections = new Map<string, WebSocket>();

  // Create HTTP server for health check
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mode: 'execution' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  // Create WebSocket server
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    logger.info({ clientIp }, 'WebSocket client connected');

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as PromptMessage;

        if (message.type !== 'prompt') {
          logger.warn({ type: message.type }, 'Unknown message type');
          return;
        }

        const { chatId, prompt, messageId, senderOpenId } = message;
        logger.info({ chatId, messageId, promptLength: prompt.length }, 'Received prompt');

        // Track connection by chatId
        activeConnections.set(chatId, ws);

        // Send feedback function
        const sendFeedback = (feedback: FeedbackMessage) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(feedback));
          }
        };

        // Create Pilot callbacks that send feedback via WebSocket
        const callbacks: PilotCallbacks = {
          sendMessage: async (_, text: string) => {
            sendFeedback({ type: 'text', chatId, text });
          },
          sendCard: async (_, card: Record<string, unknown>, description?: string) => {
            sendFeedback({ type: 'card', chatId, card, text: description });
          },
          sendFile: async (_, filePath: string) => {
            sendFeedback({ type: 'file', chatId, filePath });
          },
        };

        // Create Pilot instance
        const pilot = new Pilot({
          apiKey: agentConfig.apiKey,
          model: agentConfig.model,
          apiBaseUrl: agentConfig.apiBaseUrl,
          isCliMode: true,
          callbacks,
        });

        try {
          // Execute the prompt
          await pilot.executeOnce(chatId, prompt, messageId, senderOpenId);

          // Send done signal
          sendFeedback({ type: 'done', chatId });
        } catch (error) {
          const err = error as Error;
          logger.error({ err, chatId }, 'Execution failed');
          sendFeedback({ type: 'error', chatId, error: err.message });
        } finally {
          activeConnections.delete(chatId);
        }
      } catch (error) {
        logger.error({ err: error }, 'Failed to process message');
      }
    });

    ws.on('close', () => {
      logger.info({ clientIp }, 'WebSocket client disconnected');
    });

    ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket error');
    });
  });

  // Start server
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  logger.info({ port, host }, 'Execution Node listening');
  console.log('✓ Execution Node ready');
  console.log();
  console.log('WebSocket server:');
  console.log(`  ws://${host}:${port}`);
  console.log();
  console.log('HTTP endpoints:');
  console.log('  GET /health - Health check');
  console.log();

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Execution Node...');
    console.log('\nShutting down Execution Node...');

    // Close all WebSocket connections
    for (const [chatId, ws] of activeConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    activeConnections.clear();

    // Close servers
    wss.close();
    httpServer.close();

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { ExecNodeConfig };

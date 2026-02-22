/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks.
 * Connects to Communication Node via WebSocket as a client.
 */

import WebSocket from 'ws';
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
 * Run Execution Node (Pilot Agent with WebSocket client).
 *
 * Connects to Communication Node via WebSocket and handles prompt execution requests.
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runExecutionNode(config?: ExecNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getExecNodeConfig(globalArgs);

  // Get comm URL from config
  const commUrl = runnerConfig.commUrl;
  const reconnectInterval = 3000;
  let ws: WebSocket | undefined;
  let running = true;
  let reconnectTimer: NodeJS.Timeout | undefined;

  logger.info({ commUrl }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log(`Mode: Execution (Pilot Agent + WebSocket Client)`);
  console.log(`Comm URL: ${commUrl}`);
  console.log();

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  /**
   * Connect to Communication Node via WebSocket.
   */
  function connectToCommNode(): void {
    if (ws?.readyState === WebSocket.OPEN) {
      return;
    }

    logger.info({ url: commUrl }, 'Connecting to Communication Node...');

    ws = new WebSocket(commUrl);

    ws.on('open', () => {
      logger.info('Connected to Communication Node');
      console.log('✓ Connected to Communication Node');
      console.log();
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString()) as PromptMessage;

        if (message.type !== 'prompt') {
          logger.warn({ type: message.type }, 'Unknown message type');
          return;
        }

        const { chatId, prompt, messageId, senderOpenId } = message;
        logger.info({ chatId, messageId, promptLength: prompt.length }, 'Received prompt');

        // Send feedback function
        const sendFeedback = (feedback: FeedbackMessage) => {
          if (ws?.readyState === WebSocket.OPEN) {
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
        }
      } catch (error) {
        logger.error({ err: error }, 'Failed to process message');
      }
    });

    ws.on('close', () => {
      logger.info('Disconnected from Communication Node');
      console.log('Disconnected from Communication Node');

      // Reconnect if still running
      if (running) {
        scheduleReconnect();
      }
    });

    ws.on('error', (error) => {
      logger.error({ err: error }, 'WebSocket error');
    });
  }

  /**
   * Schedule reconnection to Communication Node.
   */
  function scheduleReconnect(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      if (running) {
        connectToCommNode();
      }
    }, reconnectInterval);
  }

  // Start connection
  connectToCommNode();

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Execution Node...');
    console.log('\nShutting down Execution Node...');

    running = false;

    // Clear reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    // Close WebSocket connection
    if (ws) {
      ws.close();
      ws = undefined;
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { ExecNodeConfig };

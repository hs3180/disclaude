/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks.
 * Connects to Communication Node via WebSocket as a client.
 */

import * as path from 'path';
import WebSocket from 'ws';
import { Config } from '../config/index.js';
import { Pilot } from '../agents/pilot.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getExecNodeConfig, type ExecNodeConfig } from '../utils/cli-args.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
  setScheduleManager,
  setScheduler,
} from '../schedule/index.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { setTaskFlowOrchestrator } from '../mcp/task-skill-mcp.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type { PromptMessage, CommandMessage, FeedbackMessage } from '../types/websocket-messages.js';
import { FileClient } from '../transport/file-client.js';

const logger = createLogger('ExecRunner');

/**
 * Run Execution Node (Pilot Agent with WebSocket client).
 *
 * Connects to Communication Node via WebSocket and handles prompt execution requests.
 * Uses a shared Pilot instance to maintain conversation context across messages.
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runExecutionNode(config?: ExecNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getExecNodeConfig(globalArgs);

  // Get comm URL from config
  const {commUrl} = runnerConfig;
  const reconnectInterval = 3000;
  let ws: WebSocket | undefined;
  let running = true;
  let reconnectTimer: NodeJS.Timeout | undefined;

  logger.info({ commUrl }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log('Mode: Execution (Pilot Agent + WebSocket Client)');
  console.log(`Comm URL: ${commUrl}`);
  console.log();

  // Get agent configuration
  const agentConfig = Config.getAgentConfig();

  // Create FileClient for file transfer with Communication Node
  const commHttpUrl = commUrl.replace(/^ws/, 'http');
  const fileClient = new FileClient({
    commNodeUrl: commHttpUrl,
    downloadDir: path.join(Config.getWorkspaceDir(), 'downloads'),
  });

  // Map to store active feedback context per chatId
  // Includes sendFeedback function and parentId for thread replies
  interface FeedbackContext {
    sendFeedback: (feedback: FeedbackMessage) => void;
    parentId?: string;
  }
  const activeFeedbackChannels = new Map<string, FeedbackContext>();

  /**
   * Create a shared Pilot instance for all messages.
   * This ensures conversation context is maintained across messages for each chatId.
   *
   * The callbacks use the activeFeedbackChannels map to find the correct
   * WebSocket feedback function for each chatId.
   */
  const sharedPilot = new Pilot({
    apiKey: agentConfig.apiKey,
    model: agentConfig.model,
    apiBaseUrl: agentConfig.apiBaseUrl,
    isCliMode: false, // Enable persistent sessions for context retention
    callbacks: {
      sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text, parentId: parentMessageId || ctx.parentId });
        } else {
          logger.warn({ chatId }, 'No active feedback channel for sendMessage');
        }
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, parentId: parentMessageId || ctx.parentId });
        } else {
          logger.warn({ chatId }, 'No active feedback channel for sendCard');
        }
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (!ctx) {
          logger.warn({ chatId }, 'No active feedback channel for sendFile');
          return;
        }

        try {
          // Upload file to Communication Node
          const fileRef = await fileClient.uploadFile(filePath, chatId);

          // Send fileRef to Communication Node
          ctx.sendFeedback({
            type: 'file',
            chatId,
            fileRef,
            fileName: fileRef.fileName,
            fileSize: fileRef.size,
            mimeType: fileRef.mimeType,
            parentId: ctx.parentId,
          });
        } catch (error) {
          logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
          ctx.sendFeedback({
            type: 'error',
            chatId,
            error: `Failed to send file: ${(error as Error).message}`,
            parentId: ctx.parentId,
          });
        }
      },
      onDone: async (chatId: string, parentMessageId?: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'done', chatId, parentId: parentMessageId || ctx.parentId });
          logger.info({ chatId }, 'Task completed, sent done signal');
        } else {
          logger.warn({ chatId }, 'No active feedback channel for onDone');
        }
      },
    },
  });

  // Initialize Schedule Manager and Scheduler
  const workspaceDir = Config.getWorkspaceDir();
  const schedulesDir = path.join(workspaceDir, 'schedules');
  const scheduleManager = new ScheduleManager({ schedulesDir });
  const scheduler = new Scheduler({
    scheduleManager,
    pilot: sharedPilot,
    callbacks: {
      sendMessage: async (chatId: string, text: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text });
        } else {
          // For scheduled tasks without active channel, we need a way to send
          // This creates a temporary feedback function
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'text', chatId, text }));
          }
        }
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, description?: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'card', chatId, card, text: description }));
        }
      },
      sendFile: async (chatId: string, filePath: string) => {
        try {
          // Upload file to Communication Node
          const fileRef = await fileClient.uploadFile(filePath, chatId);

          // Send fileRef via WebSocket
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'file',
              chatId,
              fileRef,
              fileName: fileRef.fileName,
              fileSize: fileRef.size,
              mimeType: fileRef.mimeType,
            }));
          }
        } catch (error) {
          logger.error({ err: error, chatId, filePath }, 'Failed to upload file for scheduled task');
        }
      },
    },
  });

  // Initialize file watcher for hot reload
  let fileWatcher: ScheduleFileWatcher | undefined;
  const initFileWatcher = () => {
    fileWatcher = new ScheduleFileWatcher({
      schedulesDir,
      onFileAdded: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file added, adding to scheduler');
        scheduler.addTask(task);
      },
      onFileChanged: (task) => {
        logger.info({ taskId: task.id, name: task.name }, 'Schedule file changed, updating scheduler');
        scheduler.addTask(task);
      },
      onFileRemoved: (taskId) => {
        logger.info({ taskId }, 'Schedule file removed, removing from scheduler');
        scheduler.removeTask(taskId);
      },
    });
  };

  // Register with MCP tools
  setScheduleManager(scheduleManager);
  setScheduler(scheduler);

  // Initialize TaskFlowOrchestrator for task skill dialogue phase
  // This fixes Issue #111: TaskFlowOrchestrator needs to be registered in Execution Node
  const taskTracker = new TaskTracker();
  const taskFlowOrchestrator = new TaskFlowOrchestrator(
    taskTracker,
    {
      sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'text', chatId, text, parentId: parentMessageId }));
        } else {
          logger.warn({ chatId }, 'Cannot send message: WebSocket not connected');
        }
      },
      sendCard: async (chatId: string, card: Record<string, unknown>, _description?: string, parentMessageId?: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'card', chatId, card, parentId: parentMessageId }));
        } else {
          logger.warn({ chatId }, 'Cannot send card: WebSocket not connected');
        }
      },
      sendFile: async (chatId: string, filePath: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'file', chatId, filePath }));
        } else {
          logger.warn({ chatId }, 'Cannot send file: WebSocket not connected');
        }
      },
    },
    logger
  );
  setTaskFlowOrchestrator(taskFlowOrchestrator);
  console.log('✓ TaskFlowOrchestrator registered');

  // Start scheduler
  await scheduler.start();
  console.log('✓ Scheduler started');

  // Start file watcher for hot reload
  initFileWatcher();
  await fileWatcher?.start();
  console.log('✓ Schedule file watcher started');
  console.log();

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
        const message = JSON.parse(data.toString()) as PromptMessage | CommandMessage;

        // Handle command messages
        if (message.type === 'command') {
          const { command, chatId } = message;
          logger.info({ command, chatId }, 'Received command');

          try {
            if (command === 'reset') {
              sharedPilot.resetAll();
              logger.info({ chatId }, 'Pilot reset executed');
            } else if (command === 'restart') {
              sharedPilot.resetAll();
              logger.info({ chatId }, 'Pilot restart executed (reset performed)');
            }
          } catch (error) {
            const err = error as Error;
            logger.error({ err, command, chatId }, 'Command execution failed');
          }
          return;
        }

        // Handle prompt messages
        if (message.type === 'prompt') {
          const { chatId, prompt, messageId, senderOpenId, parentId, attachments } = message;
          logger.info({ chatId, messageId, promptLength: prompt.length, parentId, hasAttachments: !!attachments }, 'Received prompt');

          // Download attachments if present
          if (attachments && attachments.length > 0) {
            logger.info({ chatId, attachmentCount: attachments.length }, 'Downloading attachments');
            for (const att of attachments) {
              try {
                const localPath = await fileClient.downloadToFile(att);
                // Update storageKey to local path for Pilot to use
                att.storageKey = localPath;
                logger.info({ fileId: att.id, fileName: att.fileName, localPath }, 'Attachment downloaded');
              } catch (error) {
                logger.error({ err: error, fileId: att.id, fileName: att.fileName }, 'Failed to download attachment');
              }
            }
          }

          // Create send feedback function for this message
          const sendFeedback = (feedback: FeedbackMessage) => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(feedback));
            }
          };

          // Register feedback channel for this chatId with parentId
          activeFeedbackChannels.set(chatId, { sendFeedback, parentId });

          try {
            // Use processMessage for persistent session context
            // The 'done' signal will be sent via onDone callback when Agent completes
            sharedPilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments);
          } catch (error) {
            const err = error as Error;
            logger.error({ err, chatId }, 'Execution failed');
            sendFeedback({ type: 'error', chatId, error: err.message, parentId });
            sendFeedback({ type: 'done', chatId, parentId });
          }
          return;
        }

        // Unknown message type
        logger.warn({ type: (message as { type?: string }).type }, 'Unknown message type');
      } catch (error) {
        logger.error({ err: error }, 'Failed to process message');
      }
    });

    ws.on('close', () => {
      logger.info('Disconnected from Communication Node');
      console.log('Disconnected from Communication Node');

      // Clear active feedback channels on disconnect
      activeFeedbackChannels.clear();

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
  const shutdown = () => {
    logger.info('Shutting down Execution Node...');
    console.log('\nShutting down Execution Node...');

    running = false;

    // Stop file watcher
    fileWatcher?.stop();

    // Stop scheduler
    scheduler.stop();

    // Clear reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    // Close WebSocket connection
    if (ws) {
      ws.close();
      ws = undefined;
    }

    // Clear active feedback channels
    activeFeedbackChannels.clear();

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Re-export type for external use
export type { ExecNodeConfig };

/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks.
 * Connects to Communication Node via WebSocket as a client.
 */

import * as path from 'path';
import WebSocket from 'ws';
import { Config } from '../config/index.js';
import { AgentFactory } from '../agents/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getExecNodeConfig, type ExecNodeConfig } from '../utils/cli-args.js';
import {
  ScheduleManager,
  Scheduler,
  ScheduleFileWatcher,
} from '../schedule/index.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
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

  // Create FileClient for file transfer with Communication Node
  const commHttpUrl = commUrl.replace(/^ws/, 'http');
  const fileClient = new FileClient({
    commNodeUrl: commHttpUrl,
    downloadDir: path.join(Config.getWorkspaceDir(), 'downloads'),
  });

  // Map to store active feedback context per chatId
  // Includes sendFeedback function and threadId for thread replies
  interface FeedbackContext {
    sendFeedback: (feedback: FeedbackMessage) => void;
    threadId?: string;
  }
  const activeFeedbackChannels = new Map<string, FeedbackContext>();

  /**
   * Create a shared Pilot instance for all messages.
   * This ensures conversation context is maintained across messages for each chatId.
   *
   * Uses AgentFactory for consistent configuration (Issue #129).
   */
  const sharedPilot = AgentFactory.createPilot({
    sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
      const ctx = activeFeedbackChannels.get(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
      } else {
        logger.warn({ chatId }, 'No active feedback channel for sendMessage');
      }
      return Promise.resolve();
    },
    sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
      const ctx = activeFeedbackChannels.get(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
      } else {
        logger.warn({ chatId }, 'No active feedback channel for sendCard');
      }
      return Promise.resolve();
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
          threadId: ctx.threadId,
        });
      } catch (error) {
        logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
        ctx.sendFeedback({
          type: 'error',
          chatId,
          error: `Failed to send file: ${(error as Error).message}`,
          threadId: ctx.threadId,
        });
      }
    },
    onDone: (chatId: string, threadMessageId?: string): Promise<void> => {
      const ctx = activeFeedbackChannels.get(chatId);
      if (ctx) {
        ctx.sendFeedback({ type: 'done', chatId, threadId: threadMessageId || ctx.threadId });
        logger.info({ chatId }, 'Task completed, sent done signal');
      } else {
        logger.warn({ chatId }, 'No active feedback channel for onDone');
      }
      return Promise.resolve();
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
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'text', chatId, text, threadId: threadMessageId || ctx.threadId });
        } else {
          // For scheduled tasks without active channel, send directly via WebSocket
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
          }
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          ctx.sendFeedback({ type: 'card', chatId, card, text: description, threadId: threadMessageId || ctx.threadId });
        } else {
          // For scheduled tasks without active channel, send directly via WebSocket
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'card', chatId, card, text: description, threadId: threadMessageId }));
          }
        }
        return Promise.resolve();
      },
      sendFile: async (chatId: string, filePath: string) => {
        const ctx = activeFeedbackChannels.get(chatId);
        if (ctx) {
          try {
            const fileRef = await fileClient.uploadFile(filePath, chatId);
            ctx.sendFeedback({
              type: 'file',
              chatId,
              fileRef,
              fileName: fileRef.fileName,
              fileSize: fileRef.size,
              mimeType: fileRef.mimeType,
              threadId: ctx.threadId,
            });
          } catch (error) {
            logger.error({ err: error, chatId, filePath }, 'Failed to upload file');
            ctx.sendFeedback({
              type: 'error',
              chatId,
              error: `Failed to send file: ${(error as Error).message}`,
              threadId: ctx.threadId,
            });
          }
        } else {
          // For scheduled tasks without active channel, send directly via WebSocket
          try {
            const fileRef = await fileClient.uploadFile(filePath, chatId);
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
        }
      },
    },
    // Feedback channel management for scheduled tasks
    // Provides direct WebSocket access to avoid recursion through callbacks
    setFeedbackChannel: (chatId: string, context) => {
      // Replace the placeholder sendFeedback with actual WebSocket implementation
      const actualContext = {
        sendFeedback: (feedback: FeedbackMessage) => {
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(feedback));
          }
        },
        threadId: context.threadId,
      };
      activeFeedbackChannels.set(chatId, actualContext);
      logger.debug({ chatId }, 'Feedback channel set for scheduled task');
    },
    clearFeedbackChannel: (chatId: string) => {
      activeFeedbackChannels.delete(chatId);
      logger.debug({ chatId }, 'Feedback channel cleared for scheduled task');
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

  // Initialize TaskFlowOrchestrator for deep-task skill dialogue phase
  // Uses file watcher to detect new Task.md files and trigger dialogue
  const taskTracker = new TaskTracker();
  const taskFlowOrchestrator = new TaskFlowOrchestrator(
    taskTracker,
    {
      sendMessage: (chatId: string, text: string, threadMessageId?: string): Promise<void> => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'text', chatId, text, threadId: threadMessageId }));
        } else {
          logger.warn({ chatId }, 'Cannot send message: WebSocket not connected');
        }
        return Promise.resolve();
      },
      sendCard: (chatId: string, card: Record<string, unknown>, _description?: string, threadMessageId?: string): Promise<void> => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'card', chatId, card, threadId: threadMessageId }));
        } else {
          logger.warn({ chatId }, 'Cannot send card: WebSocket not connected');
        }
        return Promise.resolve();
      },
      sendFile: (chatId: string, filePath: string): Promise<void> => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'file', chatId, filePath }));
        } else {
          logger.warn({ chatId }, 'Cannot send file: WebSocket not connected');
        }
        return Promise.resolve();
      },
    },
    logger
  );
  await taskFlowOrchestrator.start();
  console.log('✓ TaskFlowOrchestrator started with file watcher');

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
              // Use reset(chatId) to only reset the specific chat, not all chats
              sharedPilot.reset(chatId);
              logger.info({ chatId }, 'Pilot reset executed for chatId');
            } else if (command === 'restart') {
              sharedPilot.reset(chatId);
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
          const { chatId, prompt, messageId, senderOpenId, threadId, attachments } = message;
          logger.info({ chatId, messageId, promptLength: prompt.length, threadId, hasAttachments: !!attachments }, 'Received prompt');

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

          // Register feedback channel for this chatId with threadId
          activeFeedbackChannels.set(chatId, { sendFeedback, threadId });

          try {
            // Use processMessage for persistent session context
            // The 'done' signal will be sent via onDone callback when Agent completes
            sharedPilot.processMessage(chatId, prompt, messageId, senderOpenId, attachments);
          } catch (error) {
            const err = error as Error;
            logger.error({ err, chatId }, 'Execution failed');
            sendFeedback({ type: 'error', chatId, error: err.message, threadId });
            sendFeedback({ type: 'done', chatId, threadId });
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

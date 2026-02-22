/**
 * Bot runner functions for Feishu/Lark.
 *
 * This module provides the entry point for running the bot with the
 * new Transport-based architecture. It uses LocalTransport for
 * single-process mode.
 */
import { Config } from './config/index.js';
import { LocalTransport } from './transport/index.js';
import { CommunicationNode, ExecutionNode } from './nodes/index.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Bots');

/**
 * Run Feishu/Lark bot using Transport abstraction.
 *
 * This creates a CommunicationNode and ExecutionNode connected via
 * LocalTransport, all running in a single process.
 */
export async function runFeishu(): Promise<void> {
  console.log('Initializing Feishu/Lark bot...');

  // Increase max listeners to prevent MaxListenersExceededWarning
  process.setMaxListeners(20);

  // Validate required environment variables
  if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for bot mode');
  }

  // Create LocalTransport for single-process communication
  const transport = new LocalTransport();

  // Create Communication Node (handles Feishu WebSocket)
  const commNode = new CommunicationNode({
    transport,
    appId: Config.FEISHU_APP_ID,
    appSecret: Config.FEISHU_APP_SECRET,
  });

  // Create Execution Node (handles Pilot/Agent)
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport first
  await transport.start();
  logger.info('Transport started');

  // Start both nodes
  await Promise.all([commNode.start(), execNode.start()]);

  logger.info('Feishu bot started with Transport abstraction');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await commNode.stop();
    await execNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

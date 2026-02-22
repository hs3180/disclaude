/**
 * Communication Node Entry Point.
 *
 * This is the standalone entry point for running just the Communication Node.
 * It connects to Feishu and forwards tasks to an Execution Node via HTTP.
 *
 * Usage:
 * ```bash
 * node dist/communication-entry.js --execution-url http://localhost:3001
 * ```
 *
 * Environment Variables:
 * - FEISHU_APP_ID: Feishu App ID
 * - FEISHU_APP_SECRET: Feishu App Secret
 * - EXECUTION_URL: URL of the Execution Node
 * - CALLBACK_PORT: Port for receiving callbacks (default: 3002)
 * - AUTH_TOKEN: Optional authentication token
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { CommunicationNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommunicationEntry');

interface CommunicationEntryConfig {
  executionUrl: string;
  callbackPort: number;
  callbackHost: string;
  authToken?: string;
}

function parseArgs(): CommunicationEntryConfig {
  const args = process.argv.slice(2);

  let executionUrl = process.env.EXECUTION_URL || 'http://localhost:3001';
  let callbackPort = parseInt(process.env.CALLBACK_PORT || '3002', 10);
  let callbackHost = process.env.CALLBACK_HOST || 'localhost';
  let authToken = process.env.AUTH_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--execution-url' && args[i + 1]) {
      executionUrl = args[i + 1];
      i++;
    } else if (args[i] === '--callback-port' && args[i + 1]) {
      callbackPort = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--callback-host' && args[i + 1]) {
      callbackHost = args[i + 1];
      i++;
    } else if (args[i] === '--auth-token' && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    }
  }

  return { executionUrl, callbackPort, callbackHost, authToken };
}

async function main(): Promise<void> {
  const config = parseArgs();

  logger.info(
    {
      config: {
        ...config,
        authToken: config.authToken ? '***' : undefined,
      },
    },
    'Starting Communication Node'
  );

  // Validate Feishu credentials
  if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
    logger.error('Feishu credentials not configured. Set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables.');
    process.exit(1);
  }

  // Create HTTP Transport
  const transport = new HttpTransport({
    mode: 'communication',
    executionUrl: config.executionUrl,
    callbackPort: config.callbackPort,
    callbackHost: config.callbackHost,
    authToken: config.authToken,
  });

  // Create Communication Node
  const commNode = new CommunicationNode({
    transport,
    appId: Config.FEISHU_APP_ID,
    appSecret: Config.FEISHU_APP_SECRET,
  });

  // Start Transport
  await transport.start();
  logger.info(`Callback server listening on http://${config.callbackHost}:${config.callbackPort}`);
  logger.info(`Forwarding tasks to ${config.executionUrl}`);

  // Start Communication Node (connects to Feishu)
  await commNode.start();

  logger.info('Communication Node started successfully');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Communication Node...');
    await commNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start Communication Node');
  process.exit(1);
});

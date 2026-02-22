/**
 * Communication Node Runner.
 *
 * Runs the Communication Node which handles Feishu WebSocket connections
 * and forwards tasks to Execution Node via HTTP.
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { CommunicationNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('CommRunner');

interface CommRunnerConfig {
  port: number;
  host: string;
  callbackPort?: number;
  authToken?: string;
}

/**
 * Parse command line arguments for Communication Node.
 */
function parseArgs(): CommRunnerConfig {
  const args = process.argv.slice(2);
  const transportConfig = Config.getTransportConfig();

  let port = transportConfig.http?.communication?.callbackPort ||
             transportConfig.http?.execution?.port ||
             parseInt(process.env.PORT || '3001', 10);
  let host = transportConfig.http?.communication?.callbackHost ||
             process.env.HOST || '0.0.0.0';
  let callbackPort = transportConfig.http?.communication?.callbackPort || port + 1;
  let authToken = transportConfig.http?.authToken || process.env.AUTH_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--host' && args[i + 1]) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--callback-port' && args[i + 1]) {
      callbackPort = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--auth-token' && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    }
  }

  return { port, host, callbackPort, authToken };
}

/**
 * Run Communication Node (Feishu WebSocket handler with HTTP server).
 *
 * This starts an HTTP server that:
 * 1. Receives tasks from Feishu
 * 2. Forwards tasks to Execution Node
 * 3. Receives callbacks from Execution Node
 */
export async function runCommunicationNode(): Promise<void> {
  const config = parseArgs();

  logger.info({
    config: {
      ...config,
      authToken: config.authToken ? '***' : undefined
    }
  }, 'Starting Communication Node');

  console.log('Initializing Communication Node...');
  console.log(`Mode: Communication (Feishu WebSocket + HTTP Server)`);
  console.log(`Port: ${config.port}`);
  console.log(`Host: ${config.host}`);
  console.log();

  // Validate Feishu configuration
  if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
    throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required for Communication Node');
  }

  // Increase max listeners
  process.setMaxListeners(20);

  // Create HTTP Transport (Server mode)
  const transport = new HttpTransport({
    mode: 'communication',
    port: config.port,
    host: config.host,
    authToken: config.authToken,
  });

  // Create Communication Node (handles Feishu WebSocket)
  const commNode = new CommunicationNode({
    transport,
    appId: Config.FEISHU_APP_ID,
    appSecret: Config.FEISHU_APP_SECRET,
  });

  // Start Transport (HTTP Server)
  await transport.start();
  logger.info(`Communication Node listening on http://${config.host}:${config.port}`);
  console.log('Endpoints:');
  console.log('  POST /task     - Receive tasks from Feishu');
  console.log('  POST /callback - Receive messages from Execution Node');
  console.log('  POST /control  - Receive control commands');
  console.log('  GET  /health   - Health check');
  console.log();

  // Start Communication Node
  await commNode.start();

  logger.info('Communication Node started successfully');
  console.log('✓ Communication Node ready');
  console.log();
  console.log('Waiting for Execution Node to connect...');
  console.log('  Execution Node should connect to: http://localhost:' + config.port);

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Communication Node...');
    console.log('\nShutting down Communication Node...');
    await commNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks
 * and communicates with Communication Node via HTTP.
 */

import { Config } from '../config/index.js';
import { HttpTransport } from '../transport/index.js';
import { ExecutionNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ExecRunner');

interface ExecRunnerConfig {
  communicationUrl: string;
  port?: number;
  authToken?: string;
}

/**
 * Parse command line arguments for Execution Node.
 */
function parseArgs(): ExecRunnerConfig {
  const args = process.argv.slice(2);
  const transportConfig = Config.getTransportConfig();

  let communicationUrl = transportConfig.http?.communication?.executionUrl ||
                         process.env.COMMUNICATION_URL ||
                         'http://localhost:3001';
  let port = transportConfig.http?.execution?.port ||
             parseInt(process.env.PORT || '3001', 10);
  let authToken = transportConfig.http?.authToken || process.env.AUTH_TOKEN;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--communication-url' && args[i + 1]) {
      communicationUrl = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--auth-token' && args[i + 1]) {
      authToken = args[i + 1];
      i++;
    }
  }

  return { communicationUrl, port, authToken };
}

/**
 * Run Execution Node (Pilot/Agent handler with HTTP client).
 *
 * This connects to Communication Node and:
 * 1. Receives tasks from Communication Node
 * 2. Executes tasks via Pilot Agent
 * 3. Sends results back to Communication Node
 */
export async function runExecutionNode(): Promise<void> {
  const config = parseArgs();

  logger.info({
    config: {
      ...config,
      authToken: config.authToken ? '***' : undefined
    }
  }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log(`Mode: Execution (Pilot Agent + HTTP Client)`);
  console.log(`Communication URL: ${config.communicationUrl}`);
  console.log();

  // Increase max listeners
  process.setMaxListeners(20);

  // Create HTTP Transport (Client mode)
  const transport = new HttpTransport({
    mode: 'execution',
    communicationUrl: config.communicationUrl,
    authToken: config.authToken,
  });

  // Create Execution Node (handles Pilot/Agent)
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport
  await transport.start();
  logger.info(`Execution Node connecting to ${config.communicationUrl}`);

  // Start Execution Node (registers handlers)
  await execNode.start();

  logger.info('Execution Node started successfully');
  console.log('✓ Execution Node ready');
  console.log();
  console.log('Ready to process tasks from Communication Node');

  // Handle shutdown
  const shutdown = async () => {
    logger.info('Shutting down Execution Node...');
    console.log('\nShutting down Execution Node...');
    await execNode.stop();
    await transport.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

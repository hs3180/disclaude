/**
 * Execution Node Runner.
 *
 * Runs the Execution Node which handles Pilot/Agent tasks
 * and communicates with Communication Node via HTTP.
 */

import { HttpTransport } from '../transport/index.js';
import { ExecutionNode } from '../nodes/index.js';
import { createLogger } from '../utils/logger.js';
import { parseGlobalArgs, getExecNodeConfig, type ExecNodeConfig } from '../utils/cli-args.js';

const logger = createLogger('ExecRunner');

/**
 * Run Execution Node (Pilot/Agent handler with HTTP client).
 *
 * This connects to Communication Node and:
 * 1. Receives tasks from Communication Node
 * 2. Executes tasks via Pilot Agent
 * 3. Sends results back to Communication Node
 *
 * @param config - Optional configuration (uses CLI args if not provided)
 */
export async function runExecutionNode(config?: ExecNodeConfig): Promise<void> {
  const globalArgs = parseGlobalArgs();
  const runnerConfig = config || getExecNodeConfig(globalArgs);

  logger.info({
    config: {
      ...runnerConfig,
      authToken: runnerConfig.authToken ? '***' : undefined
    }
  }, 'Starting Execution Node');

  console.log('Initializing Execution Node...');
  console.log(`Mode: Execution (Pilot Agent + HTTP Client)`);
  console.log(`Communication URL: ${runnerConfig.communicationUrl}`);
  console.log();

  // Increase max listeners
  process.setMaxListeners(20);

  // Create HTTP Transport (Client mode)
  const transport = new HttpTransport({
    mode: 'execution',
    communicationUrl: runnerConfig.communicationUrl,
    authToken: runnerConfig.authToken,
  });

  // Create Execution Node (handles Pilot/Agent)
  const execNode = new ExecutionNode({
    transport,
    isCliMode: false,
  });

  // Start Transport
  await transport.start();
  logger.info(`Execution Node connecting to ${runnerConfig.communicationUrl}`);

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

// Re-export type for external use
export type { ExecNodeConfig };

#!/usr/bin/env node
/**
 * CLI entry point for @disclaude/primary-node
 *
 * Usage:
 *   disclaude-primary start [--rest-port PORT] [--host HOST] [--config PATH]
 *
 * This starts the Primary Node with a REST channel for API access.
 *
 * @module primary-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
  type IncomingMessage,
  type ControlCommand,
  type ControlResponse,
  getProvider,
  type AgentQueryOptions,
  Config,
  buildSdkEnv,
} from '@disclaude/core';
import { PrimaryNode } from './primary-node.js';
import { RestChannel, type RestChannelConfig } from './channels/rest-channel.js';

const logger = createLogger('PrimaryNodeCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  restPort?: number;
  host?: string;
  configPath?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: 'help' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'start') {
      options.command = 'start';
    } else if (arg === '--rest-port' || arg === '-p') {
      const value = args[++i];
      if (value) {
        options.restPort = parseInt(value, 10);
        if (isNaN(options.restPort)) {
          console.error('Error: --rest-port requires a valid number');
          process.exit(1);
        }
      }
    } else if (arg === '--host' || arg === '-h') {
      const value = args[++i];
      if (value) {
        options.host = value;
      }
    } else if (arg === '--config' || arg === '-c') {
      const value = args[++i];
      if (value) {
        options.configPath = value;
      }
    } else if (arg === '--help') {
      options.command = 'help';
    }
  }

  return options;
}

/**
 * Print usage information.
 */
function printUsage(): void {
  console.log(`
@disclaude/primary-node - Primary Node for disclaude

Usage:
  disclaude-primary start [options]

Commands:
  start    Start the Primary Node server

Options:
  --rest-port, -p PORT    REST API port (default: 3099)
  --host, -h HOST         Host to bind to (default: 127.0.0.1)
  --config, -c PATH       Path to configuration file
  --help                  Show this help message

Examples:
  disclaude-primary start
  disclaude-primary start --rest-port 8080
  disclaude-primary start --host 0.0.0.0 --rest-port 3000
  disclaude-primary start --config /path/to/disclaude.config.yaml
`);
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  if (options.command === 'help' || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Load configuration if provided
  if (options.configPath) {
    logger.info({ path: options.configPath }, 'Loading configuration file');
    const config = loadConfigFile(options.configPath);
    if (!config._fromFile) {
      logger.error({ path: options.configPath }, 'Failed to load configuration file');
      console.error(`Error: Could not load configuration file: ${options.configPath}`);
      process.exit(1);
    }
    setLoadedConfig(config);
    logger.info({ path: config._source }, 'Configuration loaded successfully');
  }

  // Get configuration values
  const restPort = options.restPort ?? 3099;
  const host = options.host ?? '127.0.0.1';

  logger.info({ restPort, host }, 'Starting Primary Node');

  // Create PrimaryNode
  const primaryNode = new PrimaryNode({
    host,
    enableLocalExec: true,
  });

  // Create and register REST channel
  const restChannelConfig: RestChannelConfig = {
    port: restPort,
    host,
  };

  const restChannel = new RestChannel(restChannelConfig);

  // Get the SDK provider
  const sdkProvider = getProvider();

  // Get agent configuration from loaded config
  let agentConfig: { apiKey: string; model: string; apiBaseUrl?: string };
  try {
    agentConfig = Config.getAgentConfig();
    logger.info(
      { provider: agentConfig.apiBaseUrl ? 'glm' : 'anthropic', model: agentConfig.model },
      'Agent configuration loaded'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to get agent configuration');
    console.error('Error: No API key configured. Please set up disclaude.config.yaml with glm or anthropic settings.');
    process.exit(1);
  }

  /**
   * Create SDK options for agent execution.
   * Uses buildSdkEnv for proper environment setup including PATH and CLAUDECODE handling.
   */
  const createSdkOptions = (): AgentQueryOptions => {
    // Use buildSdkEnv to properly set up environment:
    // - Includes PATH for node to be found by subprocess
    // - Removes CLAUDECODE to prevent nested session detection
    // - Sets DEBUG_CLAUDE_AGENT_SDK for debug logging
    const env = buildSdkEnv(
      agentConfig.apiKey,
      agentConfig.apiBaseUrl,
      {}, // no extra env
      true // enable SDK debug
    );

    return {
      cwd: Config.getWorkspaceDir(),
      model: agentConfig.model,
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
      env,
    };
  };

  // Set up message handler to process messages through agent
  restChannel.onMessage(async (message: IncomingMessage) => {
    const { chatId, content, messageId } = message;
    logger.info({ chatId, messageId, contentLength: content.length }, 'Processing message from REST channel');

    try {
      const options = createSdkOptions();

      // Process message through SDK
      for await (const agentMessage of sdkProvider.queryOnce(content, options)) {
        logger.debug({ chatId, type: agentMessage.type }, 'Agent message received');

        // Send message content to REST channel
        if (agentMessage.content) {
          await restChannel.sendMessage({
            chatId,
            type: 'text',
            text: agentMessage.content,
          });
        }

        // Check for completion (result type means query is done)
        if (agentMessage.type === 'result') {
          logger.info({ chatId }, 'Agent query completed');
          // Signal completion for sync mode
          await restChannel.sendMessage({
            chatId,
            type: 'done',
          });
        }
      }
    } catch (error) {
      logger.error({ err: error, chatId, messageId }, 'Failed to process message');
      // Send error response
      const errorMsg = error instanceof Error ? error.message : String(error);
      await restChannel.sendMessage({
        chatId,
        type: 'text',
        text: `❌ Error: ${errorMsg}`,
      });
      await restChannel.sendMessage({
        chatId,
        type: 'done',
      });
    }
  });

  // Set up control handler for commands like reset
  // eslint-disable-next-line require-await
  restChannel.onControl(async (command: ControlCommand): Promise<ControlResponse> => {
    logger.debug({ type: command.type, chatId: command.chatId }, 'Received control command');

    if (command.type === 'reset') {
      // For queryOnce mode, there's no persistent session to reset
      // Just return success
      return { success: true, message: 'Session reset (no persistent state)' };
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  });

  primaryNode.registerChannel(restChannel);

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {return;}
    isShuttingDown = true;
    logger.info('Shutting down Primary Node...');

    try {
      await restChannel.stop();
      await primaryNode.stop();
      logger.info('Primary Node stopped');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Start PrimaryNode
    await primaryNode.start();

    // Start REST channel
    await restChannel.start();

    logger.info({ restPort, host }, 'Primary Node started successfully');
    console.log(`Primary Node started on http://${host}:${restPort}`);
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Primary Node');
    console.error('Failed to start Primary Node:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  logger.error({ err: error }, 'Unhandled error in main');
  console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
/**
 * CLI entry point for @disclaude/primary-node
 *
 * Usage:
 *   disclaude-primary start [--config PATH]
 *
 * This starts the Primary Node with a REST channel for API access.
 * All configuration (port, host, etc.) is read from the config file.
 *
 * Issue #1594 Phase 2: Channel setup uses ChannelLifecycleManager with
 * WiredChannelDescriptors, reducing channel-specific code from ~220 lines to ~15 lines.
 *
 * @module primary-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
  Config,
  type DisclaudeConfigWithChannels,
  createControlHandler,
  type ControlHandlerContext,
} from '@disclaude/core';
import { PrimaryNode } from './primary-node.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import { createFeishuMessageBuilderOptions } from './messaging/adapters/feishu-message-builder.js';
import { ChannelLifecycleManager } from './channel-lifecycle-manager.js';
import { REST_WIRED_DESCRIPTOR, FEISHU_WIRED_DESCRIPTOR, WECHAT_WIRED_DESCRIPTOR } from './channels/wired-descriptors.js';

const logger = createLogger('PrimaryNodeCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  configPath?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { command: 'help' };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === 'start') {
      options.command = 'start';
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
  --config, -c PATH       Path to configuration file
  --help                  Show this help message

Configuration:
  All settings (port, host, etc.) are read from the config file.
  See disclaude.config.yaml for available options.

Examples:
  disclaude-primary start
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

  // Get configuration values from config file
  const rawConfig = Config.getRawConfig() as DisclaudeConfigWithChannels;
  const restChannelConfig = rawConfig.channels?.rest as {
    port?: number;
    host?: string;
    fileStorageDir?: string;
  } | undefined;

  // WeChat channel config (Issue #1554)
  const wechatChannelConfig = rawConfig.channels?.wechat as {
    enabled?: boolean;
    baseUrl?: string;
    token?: string;
    routeTag?: string;
  } | undefined;

  // Check if channels are configured
  const hasFeishuConfig = Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET;
  const hasRestConfig = restChannelConfig?.port && restChannelConfig?.host && restChannelConfig?.fileStorageDir;
  const hasWechatConfig = wechatChannelConfig?.enabled !== false && !!wechatChannelConfig;

  // At least one channel must be configured
  if (!hasFeishuConfig && !hasRestConfig && !hasWechatConfig) {
    console.error('Error: At least one channel must be configured.');
    console.error('  - For Feishu: set feishu.appId and feishu.appSecret');
    console.error('  - For REST: set channels.rest.port, host, and fileStorageDir');
    console.error('  - For WeChat: set channels.wechat with baseUrl');
    process.exit(1);
  }

  const restPort = restChannelConfig?.port || 3000;
  const host = restChannelConfig?.host || '0.0.0.0';
  const fileStorageDir = restChannelConfig?.fileStorageDir || './data/rest-files';

  logger.info({ restPort, host, fileStorageDir, hasRestConfig, hasFeishuConfig, hasWechatConfig }, 'Starting Primary Node');

  // Create PrimaryNode
  const primaryNode = new PrimaryNode({
    host,
    enableLocalExec: true,
  });

  // Get ChannelManager from PrimaryNode (Issue #1594)
  const channelManager = primaryNode.getChannelManager();

  // Get agent configuration from loaded config (validates API key is available)
  try {
    const agentConfig = Config.getAgentConfig();
    logger.info(
      { provider: agentConfig.apiBaseUrl ? 'glm' : 'anthropic', model: agentConfig.model },
      'Agent configuration loaded'
    );
  } catch (error) {
    logger.error({ err: error }, 'Failed to get agent configuration');
    console.error('Error: No API key configured. Please set up disclaude.config.yaml with glm or anthropic settings.');
    process.exit(1);
  }

  // Create AgentPool for Primary Node with Feishu message builder options
  // Issue #1499: Channel-specific options are injected here, not in worker-node
  const agentPool = new PrimaryAgentPool({
    messageBuilderOptions: createFeishuMessageBuilderOptions(),
  });

  // Create unified control handler context
  const controlHandlerContext: ControlHandlerContext = {
    agentPool: {
      reset: (chatId: string) => agentPool.reset(chatId),
      stop: (chatId: string) => agentPool.stop(chatId),
    },
    node: {
      nodeId: primaryNode.getNodeId(),
      getExecNodes: () => primaryNode.getExecNodeRegistry().getNodes(),
      getDebugGroup: () => primaryNode.getDebugGroupService().getDebugGroup(),
      clearDebugGroup: () => primaryNode.getDebugGroupService().clearDebugGroup(),
    },
    logger,
  };

  // Create unified control handler for all channels
  const controlHandler = createControlHandler(controlHandlerContext);

  // Create ChannelLifecycleManager (Issue #1594 Phase 2)
  const lifecycleManager = new ChannelLifecycleManager(channelManager, {
    agentPool,
    controlHandler,
    controlHandlerContext,
    logger,
    primaryNode,
  });

  // Create and wire channels using descriptors (Issue #1594 Phase 2)
  // Each descriptor encapsulates callbacks, message handler, and setup logic.
  // This replaces ~220 lines of channel-specific code with descriptor-based wiring.
  if (hasRestConfig) {
    await lifecycleManager.createAndWire(REST_WIRED_DESCRIPTOR, {
      port: restPort,
      host,
      fileStorageDir,
    });
  }

  if (hasFeishuConfig) {
    await lifecycleManager.createAndWire(FEISHU_WIRED_DESCRIPTOR, {
      appId: Config.FEISHU_APP_ID,
      appSecret: Config.FEISHU_APP_SECRET,
    });
  }

  // WeChat Channel (Issue #1554)
  if (hasWechatConfig) {
    await lifecycleManager.createAndWire(WECHAT_WIRED_DESCRIPTOR, {
      baseUrl: wechatChannelConfig!.baseUrl,
      token: wechatChannelConfig!.token,
      routeTag: wechatChannelConfig!.routeTag,
    });
  }

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {return;}
    isShuttingDown = true;
    logger.info('Shutting down Primary Node...');

    try {
      agentPool.disposeAll();
      await lifecycleManager.stopAll();
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

    // Start all registered channels via ChannelLifecycleManager (Issue #1594 Phase 2)
    await lifecycleManager.startAll();

    // Log startup info
    if (hasRestConfig) {
      logger.info({ restPort, host }, 'REST Channel started');
      console.log(`REST Channel started on http://${host}:${restPort}`);
    }
    if (hasFeishuConfig) {
      logger.info('Feishu Channel started');
    }
    if (hasWechatConfig) {
      logger.info('WeChat Channel started');
    }

    logger.info({ hasRest: hasRestConfig, hasFeishu: hasFeishuConfig, hasWechat: hasWechatConfig }, 'Primary Node started successfully');
    if (hasRestConfig) {
      console.log(`Primary Node started on http://${host}:${restPort}`);
    } else if (hasWechatConfig) {
      console.log('Primary Node started (WeChat mode)');
    } else {
      console.log('Primary Node started (Feishu only mode)');
    }
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

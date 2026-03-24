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
 * @module primary-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  createLogger,
  Config,
  type FeishuApiHandlers,
  type DisclaudeConfigWithChannels,
  createControlHandler,
  type ControlHandlerContext,
} from '@disclaude/core';
import { PrimaryNode } from './primary-node.js';
import { getDefaultChannelRegistry } from './channels/channel-descriptors.js';
import type { RestChannelConfig } from './channels/rest-channel.js';
import type { FeishuChannelConfig } from './channels/feishu-channel.js';
import type { WeChatChannelConfig } from './channels/wechat/index.js';
import type { IChannel } from '@disclaude/core';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import { createFeishuMessageBuilderOptions } from './messaging/adapters/feishu-message-builder.js';
import { setupChannelHandlers } from './handlers/channel-handler-factory.js';

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
  const channelsConfig = rawConfig.channels ?? {};
  const restChannelConfig = channelsConfig.rest as {
    port?: number;
    host?: string;
    fileStorageDir?: string;
  } | undefined;
  const wechatChannelConfig = channelsConfig.wechat as {
    enabled?: boolean;
    baseUrl?: string;
    token?: string;
    routeTag?: string;
  } | undefined;

  // Check if channels are configured
  const hasFeishuConfig = Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET;
  const hasRestConfig = restChannelConfig?.port && restChannelConfig?.host && restChannelConfig?.fileStorageDir;
  const hasWechatConfig = wechatChannelConfig && wechatChannelConfig.enabled !== false;

  // At least one channel must be configured
  if (!hasFeishuConfig && !hasRestConfig && !hasWechatConfig) {
    console.error('Error: At least one channel must be configured.');
    console.error('  - For Feishu: set feishu.appId and feishu.appSecret');
    console.error('  - For REST: set channels.rest.port, host, and fileStorageDir');
    console.error('  - For WeChat: set channels.wechat.enabled: true');
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

  // Create channel registry and register built-in channel types (Issue #1554)
  const registry = getDefaultChannelRegistry();

  // Create configured channels
  let restChannel: IChannel | undefined;
  if (hasRestConfig) {
    const restConfig: RestChannelConfig = {
      port: restPort,
      host,
      fileStorageDir,
    };
    restChannel = registry.create('rest', restConfig);
  }

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

  // Set up REST channel handlers (Issue #1555: unified handler injection)
  if (restChannel) {
    // REST uses sendDoneSignal for sync mode signaling
    setupChannelHandlers(restChannel, agentPool, controlHandler, { sendDoneSignal: true });
    primaryNode.registerChannel(restChannel);
  }

  // Set up Feishu channel (via registry)
  let feishuChannel: IChannel | undefined;
  if (Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET) {
    logger.info('Starting Feishu Channel');

    const feishuChannelConfig: FeishuChannelConfig = {
      appId: Config.FEISHU_APP_ID,
      appSecret: Config.FEISHU_APP_SECRET,
    };

    feishuChannel = registry.create('feishu', feishuChannelConfig);

    // Integrate passive mode into unified control handler context (Issue #1464)
    // Adapter layer: ControlHandlerContext uses isEnabled/setEnabled semantics,
    // while FeishuChannel exposes isPassiveModeDisabled/setPassiveModeDisabled.
    controlHandlerContext.passiveMode = {
      isEnabled: (chatId: string) => !(feishuChannel as any).isPassiveModeDisabled(chatId),
      setEnabled: (chatId: string, enabled: boolean) =>
        (feishuChannel as any).setPassiveModeDisabled(chatId, !enabled),
    };

    // Feishu uses unified handler injection (no sendDoneSignal needed)
    setupChannelHandlers(feishuChannel, agentPool, controlHandler);
    primaryNode.registerChannel(feishuChannel);
  }

  // Set up WeChat channel (via registry)
  let wechatChannel: IChannel | undefined;
  if (hasWechatConfig) {
    logger.info('Starting WeChat Channel');

    const wechatConfig: WeChatChannelConfig = {
      baseUrl: wechatChannelConfig?.baseUrl,
      token: wechatChannelConfig?.token,
      routeTag: wechatChannelConfig?.routeTag,
    };

    wechatChannel = registry.create('wechat', wechatConfig);
    setupChannelHandlers(wechatChannel, agentPool, controlHandler);
    primaryNode.registerChannel(wechatChannel);
  }

  // Collect all channels for lifecycle management
  const activeChannels = [restChannel, feishuChannel, wechatChannel].filter((c): c is IChannel => c !== undefined);

  // Handle graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) {return;}
    isShuttingDown = true;
    logger.info('Shutting down Primary Node...');

    try {
      agentPool.disposeAll();
      for (const channel of activeChannels) {
        await channel.stop();
      }
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

    // Start all configured channels
    for (const channel of activeChannels) {
      await channel.start();
      logger.info({ channelId: channel.id, channelName: channel.name }, 'Channel started');
    }

    // Register Feishu IPC handlers (Issue #1042)
    if (feishuChannel) {
      const feishuHandlers: FeishuApiHandlers = {
        sendMessage: async (chatId: string, text: string, threadId?: string) => {
          await feishuChannel.sendMessage({
            chatId,
            type: 'text',
            text,
            threadId,
          });
        },
        sendCard: async (
          chatId: string,
          card: Record<string, unknown>,
          threadId?: string,
          description?: string
        ) => {
          await feishuChannel.sendMessage({
            chatId,
            type: 'card',
            card,
            threadId,
            description,
          });
        },
        uploadFile: async (chatId: string, filePath: string, threadId?: string) => {
          await feishuChannel.sendMessage({
            chatId,
            type: 'file',
            filePath,
            threadId,
          });
          return {
            fileKey: '',
            fileType: 'file',
            fileName: filePath.split('/').pop() || 'file',
            fileSize: 0,
          };
        },
        // eslint-disable-next-line require-await
        getBotInfo: async () => {
          return (feishuChannel as any).getBotInfo();
        },
      };
      primaryNode.registerFeishuHandlers(feishuHandlers);
      logger.info('Feishu IPC handlers registered');
    }

    logger.info({ channelCount: activeChannels.length }, 'Primary Node started successfully');
    if (restChannel) {
      console.log(`Primary Node started on http://${host}:${restPort}`);
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

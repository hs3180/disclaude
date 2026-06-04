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
 * Issue #1594 Phase 3: Channel setup is fully config-driven via
 * ChannelLifecycleManager.createAndWireByType(). Adding a new channel
 * only requires a WiredChannelDescriptor + config entry — zero changes to cli.ts.
 *
 * @module primary-node/cli
 */

import {
  loadConfigFile,
  setLoadedConfig,
  applyGlobalEnv,
  createDefaultRuntimeContext,
  createLogger,
  initLogger,
  flushLogger,
  Config,
  type DisclaudeConfigWithChannels,
  createControlHandler,
  type ControlHandlerContext,
  ProcessLock,
  ProjectManager,
} from '@disclaude/core';
import { PrimaryNode } from './primary-node.js';
import { PrimaryAgentPool } from './primary-agent-pool.js';
import { createFeishuMessageBuilderOptions } from './messaging/adapters/feishu-message-builder.js';
import { ChannelLifecycleManager } from './channel-lifecycle-manager.js';
import { BUILTIN_WIRED_DESCRIPTORS } from './channels/wired-descriptors.js';
import { createChannelCallbacksFactory } from './utils/channel-handlers.js';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';

const logger = createLogger('PrimaryNodeCLI');

/**
 * Parse command line arguments.
 */
interface CliOptions {
  command: 'start' | 'help';
  configPath?: string;
}

export function parseArgs(args: string[]): CliOptions {
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

  // Initialize logger with file logging support.
  // When LOG_TO_FILE=true (set by launchd), writes to a single log file.
  // Issue #3416: Rotation delegated to system-level tools (logrotate / newsyslog).
  // Pass elasticsearch config from config file to enable ES logging transport.
  const loggingConfig = Config.getLoggingConfig();
  await initLogger({
    level: loggingConfig.level as import('@disclaude/core').LogLevel,
    elasticsearch: loggingConfig.elasticsearch,
  });

  // Issue #3417: Acquire process lock to prevent multiple concurrent instances.
  // When launchd restarts after a crash, the old process may still be exiting.
  // The PID file lock ensures only one instance runs at a time.
  const lockfilePath = process.env.LOCKFILE_PATH
    ?? path.resolve(process.env.LOG_DIR ?? path.join(homedir(), 'Library/Logs/disclaude'), 'disclaude.pid');
  const processLock = new ProcessLock({ lockfilePath, logger });
  if (!processLock.acquire()) {
    console.error('Error: Another instance is already running. Exiting.');
    process.exit(1);
  }

  // Load configuration if provided
  if (options.configPath) {
    logger.info({ path: options.configPath }, 'Loading configuration file');
    const config = loadConfigFile(options.configPath);
    if (!config._fromFile) {
      logger.error({ path: options.configPath }, 'Failed to load configuration file');
      console.error(`Error: Could not load configuration file: ${options.configPath}`);
      processLock.release();
      process.exit(1);
    }
    setLoadedConfig(config);
    logger.info({ path: config._source }, 'Configuration loaded successfully');
  }

  // Apply config env vars to process.env so main-process components can access them
  // Must be called AFTER setLoadedConfig() to ensure config is available
  applyGlobalEnv();

  // Set runtime context for agents (Issue #1839)
  // Provides dependency injection for BaseAgent methods (getGlobalEnv, getWorkspaceDir, etc.)
  // Without this, getGlobalEnv() returns {} and config env vars are silently dropped from SDK subprocess
  createDefaultRuntimeContext();

  // Get configuration values from config file
  const rawConfig = Config.getRawConfig() as DisclaudeConfigWithChannels;

  // Check if channels are configured
  const channelEntries = resolveChannelConfigs(rawConfig, Config);
  if (channelEntries.length === 0) {
    console.error('Error: At least one channel must be configured.');
    console.error('  - For Feishu: set feishu.appId and feishu.appSecret');
    console.error('  - For REST: set channels.rest.port, host, and fileStorageDir');
    processLock.release();
    process.exit(1);
  }

  // Derive IPC host from REST channel config if available
  const restEntry = channelEntries.find((e) => e.type === 'rest');
  const host = (restEntry?.config as { host?: string } | undefined)?.host || '0.0.0.0';

  // Issue #3417: Pre-check REST port availability before binding.
  // If the old process hasn't fully exited yet, the port may still be in use.
  // Wait with retries to give the old process time to release the port.
  if (restEntry) {
    const restConf = restEntry.config as { port: number; host: string };
    const portReady = await waitForPortAvailable(restConf.port, restConf.host, {
      maxRetries: 10,
      intervalMs: 1000,
    });
    if (!portReady) {
      logger.error(
        { port: restConf.port, host: restConf.host },
        'Port is still in use after waiting. Another instance may be running.'
      );
      console.error(`Error: Port ${restConf.port} is still in use after waiting. Exiting.`);
      processLock.release();
      process.exit(1);
    }
  }

  logger.info(
    { channels: channelEntries.map((e) => e.type) },
    'Starting Primary Node'
  );

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
    processLock.release();
    process.exit(1);
  }

  // Create AgentPool for Primary Node with Feishu message builder options
  // Issue #1499: Channel-specific options are injected here, not in worker-node
  // Issue #3519: Simplified ProjectManager — chatId → workingDir binding
  const workspaceDir = Config.getWorkspaceDir();

  const projectManager = new ProjectManager({
    workspaceDir,
  });
  logger.info({ workspaceDir }, 'ProjectManager initialized');

  const agentPool = new PrimaryAgentPool({
    messageBuilderOptions: createFeishuMessageBuilderOptions(),
    cwdProvider: projectManager.createCwdProvider(),
  });

  // Create unified control handler context
  // Issue #3807: shutdown function placeholder, set after shutdown is defined below
  // eslint-disable-next-line prefer-const
  let shutdownFn: (() => Promise<void>) | undefined;
  const controlHandlerContext: ControlHandlerContext = {
    agentPool: {
      reset: (chatId: string, skipContext?: boolean) => agentPool.reset(chatId, skipContext),
      stop: (chatId: string) => agentPool.stop(chatId),
    },
    node: {
      nodeId: primaryNode.getNodeId(),
      getDebugGroup: () => primaryNode.getDebugGroupService().getDebugGroup(),
      setDebugGroup: (chatId: string, name?: string) => primaryNode.getDebugGroupService().setDebugGroup(chatId, name),
      clearDebugGroup: () => primaryNode.getDebugGroupService().clearDebugGroup(),
    },
    projectManager,
    // Issue #3807: /restart command calls this to trigger graceful shutdown
    get shutdown() { return shutdownFn; },
    logger,
  };

  // Create unified control handler for all channels
  const controlHandler = createControlHandler(controlHandlerContext);

  // Shared context for both ChannelLifecycleManager and routerCallbacksFactory.
  // Issue #3801: Extract to avoid duplication and ensure consistent dependency injection.
  const channelSetupContext = {
    agentPool,
    controlHandler,
    controlHandlerContext,
    logger,
    primaryNode,
  };

  // Issue #3329: Initialize InputMessageRouter for unified message routing.
  // Activates the MessageRouter so both the scheduler (SystemMessage) and
  // channels (UserMessage) route through the unified path.
  // Must be called before primaryNode.start() (which calls initScheduler)
  // and before ChannelLifecycleManager construction (which passes the router to channels).
  // Issue #3801: Use descriptor-driven callback creation instead of hardcoded channel.id checks.
  // Each WiredChannelDescriptor declares its own callback options (e.g., sendDoneSignal),
  // so the routerCallbacksFactory looks up the descriptor by channel type.
  const descriptorMap = new Map(BUILTIN_WIRED_DESCRIPTORS.map((d) => [d.type, d]));
  const routerCallbacksFactory = (chatId: string) => {
    // Issue #3824: Use resolveChannelForChatId for ownership query fallback.
    // After restart, chatIdChannelMap is empty. resolveChannelForChatId queries
    // all channels via ownsChatId() to find the correct one.
    const channel = primaryNode.getChannelManager().resolveChannelForChatId(chatId);
    if (!channel) {
      throw new Error('No channel available for InputMessageRouter callbacks');
    }
    const descriptor = descriptorMap.get(channel.id);
    if (descriptor) {
      return descriptor.createCallbacks(channel, channelSetupContext)(chatId);
    }
    // Fallback for channels without a registered descriptor
    return createChannelCallbacksFactory(channel, logger)(chatId);
  };
  primaryNode.initInputMessageRouter(agentPool, routerCallbacksFactory);

  // Issue #3931: Wire agent-busy check so blocking tasks skip when agent is busy.
  // Must be called before primaryNode.start() (which calls initScheduler).
  primaryNode.setIsAgentBusy((chatId: string) => {
    const agent = agentPool.get(chatId);
    return agent ? agent.taskComplete !== undefined : false;
  });

  // Create ChannelLifecycleManager (Issue #1594 Phase 3)
  const lifecycleManager = new ChannelLifecycleManager(channelManager, {
    ...channelSetupContext,
    // Issue #3329: Pass InputMessageRouter so channels route through unified path
    inputMessageRouter: primaryNode.getInputMessageRouter(),
  });

  // Register all built-in channel descriptors (Issue #1594 Phase 3)
  // This enables config-driven creation via createAndWireByType().
  // Adding a new channel only requires adding a descriptor to BUILTIN_WIRED_DESCRIPTORS.
  for (const descriptor of BUILTIN_WIRED_DESCRIPTORS) {
    lifecycleManager.registerWiredDescriptor(descriptor);
  }

  // Create and wire channels from resolved config (Issue #1594 Phase 3)
  // Config-driven: cli.ts no longer hard-codes channel type checks.
  for (const { type, config } of channelEntries) {
    await lifecycleManager.createAndWireByType(type, config);
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
      // Issue #3417: Release process lock on shutdown so next instance can start immediately.
      processLock.release();
      logger.info('Primary Node stopped');

      // Flush all buffered log entries to disk before exiting.
      // Without this, pino's async SonicBoom writes may be lost, causing
      // log truncation in production.
      await flushLogger();

      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Error during shutdown');
      // Best-effort flush even on error
      await flushLogger().catch(() => {});
      processLock.release();
      process.exit(1);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Issue #3807: Wire shutdown to control handler context for /restart command
  shutdownFn = shutdown;

  // Issue #3494: Ensure process lock is released on uncaught exceptions.
  // Without this, a crash (e.g., logger "sonic boom is not ready yet") leaves
  // the PID file behind, blocking subsequent starts if the PID gets recycled.
  process.on('uncaughtException', async (error) => {
    logger.error({ err: error }, 'Uncaught exception');
    processLock.release();
    await flushLogger().catch(() => {});
    process.exit(1);
  });

  try {
    // Start PrimaryNode
    await primaryNode.start();

    // Start all registered channels via ChannelLifecycleManager (Issue #1594 Phase 2)
    await lifecycleManager.startAll();

    // Log startup info
    for (const { type, config } of channelEntries) {
      logger.info({ type }, `${type.charAt(0).toUpperCase() + type.slice(1)} Channel started`);
      if (type === 'rest') {
        const restConf = config as { port: number; host: string };
        console.log(`REST Channel started on http://${restConf.host}:${restConf.port}`);
      }
    }

    logger.info(
      { channels: channelEntries.map((e) => e.type) },
      'Primary Node started successfully'
    );
    if (restEntry) {
      const restConf = restEntry.config as { port: number; host: string };
      console.log(`Primary Node started on http://${restConf.host}:${restConf.port}`);
    } else {
      console.log('Primary Node started (Feishu only mode)');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to start Primary Node');
    console.error('Failed to start Primary Node:', error instanceof Error ? error.message : String(error));
    processLock.release();
    process.exit(1);
  }
}

// Run main (only when executed directly, not when imported by tests).
// Match both source (cli.ts) and built (cli.js) paths, plus the `disclaude-primary` bin symlink,
// so launchd / direct `node dist/cli.js start` invocations also enter main().
if (process.argv[1]?.match(/cli\.[jt]s$/) || process.argv[1]?.includes('disclaude-primary')) {
  main().catch((error) => {
    logger.error({ err: error }, 'Unhandled error in main');
    console.error('Unhandled error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

// ============================================================================
// Port Availability Check (Issue #3417)
// ============================================================================

/**
 * Options for waitForPortAvailable.
 */
interface PortCheckOptions {
  /** Maximum number of retries (default: 10) */
  maxRetries?: number;
  /** Delay between retries in ms (default: 1000) */
  intervalMs?: number;
}

/**
 * Check if a TCP port is available (not in use by another process).
 *
 * Attempts to create a temporary connection to the port. If the connection
 * is refused, the port is available. If it succeeds, something is listening.
 *
 * @returns `true` if port is available, `false` if still in use after all retries
 */
export async function waitForPortAvailable(
  port: number,
  host: string,
  options: PortCheckOptions = {}
): Promise<boolean> {
  const { maxRetries = 10, intervalMs = 1000 } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const available = await isPortAvailable(port, host);
    if (available) {
      if (attempt > 0) {
        logger.info({ port, host, attempts: attempt }, 'Port is now available');
      }
      return true;
    }

    if (attempt < maxRetries) {
      logger.info(
        { port, host, attempt: attempt + 1, maxRetries },
        'Port is in use, waiting for old process to release...'
      );
      await sleep(intervalMs);
    }
  }

  return false;
}

/**
 * Check if a specific port is available on the given host.
 *
 * Uses a temporary net.Server to test if the port can be bound.
 * If binding succeeds, the port is available (server is immediately closed).
 * If binding fails with EADDRINUSE, the port is occupied.
 */
export function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
        resolve(false);
      } else {
        // Unexpected error — treat as available to avoid blocking startup
        logger.warn({ err, port, host }, 'Unexpected error checking port availability');
        resolve(true);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Simple sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Config Resolution Utilities
// ============================================================================

/**
 * Resolved channel configuration entry.
 * Each entry maps a channel type to its resolved config.
 */
interface ResolvedChannelConfig {
  type: string;
  config: Record<string, unknown>;
}

/**
 * Resolve channel configurations from the loaded config.
 *
 * Handles the current mixed config structure where:
 * - REST config lives under `channels.rest`
 * - Feishu config lives under top-level `feishu.appId/appSecret`
 *
 * LIMITATION: This function has hard-coded knowledge of 'rest' and 'feishu'
 * types due to the current mixed config structure. Adding a new config-driven
 * channel type requires updating this function. A future config unification
 * (all channels under `channels.<type>`) would eliminate this limitation.
 *
 * Note: WeChat is intentionally NOT included — it only supports dynamic
 * registration at runtime (Issue #1638), not config-driven creation.
 *
 * Issue #1594 Phase 3: Centralizes config resolution so cli.ts can iterate
 * over results without hard-coded channel type checks.
 *
 * @param rawConfig - The raw config object
 * @param config - The Config singleton for accessing top-level getters
 * @returns Array of resolved channel configs
 */
export function resolveChannelConfigs(
  rawConfig: DisclaudeConfigWithChannels,
  config: typeof Config
): ResolvedChannelConfig[] {
  const entries: ResolvedChannelConfig[] = [];

  // REST channel: configured under channels.rest
  const restChannelConfig = rawConfig.channels?.rest as {
    port?: number;
    host?: string;
    fileStorageDir?: string;
  } | undefined;
  if (restChannelConfig?.port && restChannelConfig?.host && restChannelConfig?.fileStorageDir) {
    entries.push({
      type: 'rest',
      config: {
        port: restChannelConfig.port,
        host: restChannelConfig.host,
        fileStorageDir: restChannelConfig.fileStorageDir,
      },
    });
  }

  // Feishu channel: configured under top-level feishu.appId/appSecret
  const feishuAppId = config.FEISHU_APP_ID;
  const feishuAppSecret = config.FEISHU_APP_SECRET;
  if (feishuAppId && feishuAppSecret) {
    entries.push({
      type: 'feishu',
      config: { appId: feishuAppId, appSecret: feishuAppSecret },
    });
  }

  // Warn on unrecognized channel config keys (Issue #1594 review P2)
  // Note: WeChat is intentionally NOT in knownChannelKeys — it only supports
  // dynamic registration (Issue #1638), not config-driven creation.
  // If a user adds channels.wechat, they will get a warning.
  const knownChannelKeys = new Set(['rest']);
  const channelKeys = Object.keys(rawConfig.channels || {});
  for (const key of channelKeys) {
    if (!knownChannelKeys.has(key)) {
      logger.warn(
        { channelKey: key },
        `Unrecognized channel config key "channels.${key}" — this channel type is not supported`
      );
    }
  }

  return entries;
}

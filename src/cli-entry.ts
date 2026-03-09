/**
 * CLI entry point for Disclaude.
 *
 * Supports two modes:
 * - primary: Primary Node (comm + exec, recommended for single-machine)
 * - worker: Worker Node (exec only, connects to Primary)
 */

// Parse --config argument BEFORE importing Config
// This must be done first to allow loading a custom config file
import { loadConfigFile, setLoadedConfig } from './config/loader.js';
import packageJson from '../package.json' with { type: 'json' };

/**
 * Parse --config argument from command line.
 * This is done before any other imports to allow custom config loading.
 */
function parseConfigPath(): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf('--config');
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

// Load and set config from --config argument if provided
// This MUST be done before any dynamic imports of Config-dependent modules
const configPath = parseConfigPath();
if (configPath) {
  const fileConfig = loadConfigFile(configPath);
  setLoadedConfig(fileConfig);
}

// Type declarations for dynamically imported modules
type ConfigType = typeof import('./config/index.js').Config;
type InitLoggerFn = typeof import('./utils/logger.js').initLogger;
type FlushLoggerFn = typeof import('./utils/logger.js').flushLogger;
type GetRootLoggerFn = typeof import('./utils/logger.js').getRootLogger;
type SetLogLevelFn = typeof import('./utils/logger.js').setLogLevel;
type HandleErrorFn = typeof import('./utils/error-handler.js').handleError;
type ErrorCategoryType = typeof import('./utils/error-handler.js').ErrorCategory;
type SetupSkillsFn = typeof import('./utils/skills-setup.js').setupSkillsInWorkspace;
type ParseGlobalArgsFn = typeof import('./utils/cli-args.js').parseGlobalArgs;

// Module references (populated by loadDependencies)
let Config: ConfigType;
let initLogger: InitLoggerFn;
let flushLogger: FlushLoggerFn;
let getRootLogger: GetRootLoggerFn;
let setLogLevel: SetLogLevelFn;
let handleError: HandleErrorFn;
let ErrorCategory: ErrorCategoryType;
let setupSkillsInWorkspace: SetupSkillsFn;
let parseGlobalArgs: ParseGlobalArgsFn;

/**
 * Load all dependencies after config is set.
 * Uses dynamic imports to ensure Config is initialized with the correct config file.
 */
async function loadDependencies(): Promise<void> {
  const configModule = await import('./config/index.js');
  ({ Config } = configModule);

  const loggerModule = await import('./utils/logger.js');
  ({ initLogger, flushLogger, getRootLogger, setLogLevel } = loggerModule);

  const errorHandlerModule = await import('./utils/error-handler.js');
  ({ handleError, ErrorCategory } = errorHandlerModule);

  const skillsModule = await import('./utils/skills-setup.js');
  ({ setupSkillsInWorkspace } = skillsModule);

  const cliArgsModule = await import('./utils/cli-args.js');
  ({ parseGlobalArgs } = cliArgsModule);
}

/**
 * Dynamic imports for runners to avoid loading unnecessary modules.
 */
async function importRunners() {
  const runners = await import('./runners/index.js');
  return {
    runPrimaryNode: runners.runPrimaryNode,
    runWorkerNode: runners.runWorkerNode,
  };
}

// Increase max listeners to prevent memory leak warnings
// We register multiple process event handlers across the codebase
process.setMaxListeners(20);

/**
 * Show help message.
 */
function showHelp(): void {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Disclaude - Multi-platform Agent Bot');
  console.log(`  Version: ${  packageJson.version}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Usage:');
  console.log('  disclaude start --mode primary       Primary Node (Comm + Exec, recommended)');
  console.log('  disclaude start --mode worker        Worker Node (Exec only, connects to Primary)');
  console.log('');
  console.log('Options:');
  console.log('  --mode <primary|worker>              Select run mode (required for start)');
  console.log('  --config <path>                      Path to configuration file (default: auto-detect)');
  console.log('  --port <port>                        WebSocket port for primary mode (default: 3001)');
  console.log('  --rest-port <port>                   REST API port for primary mode (default: 3000)');
  console.log('  --no-rest                            Disable REST channel');
  console.log('  --comm-url <url>                     Primary Node URL for worker mode (default: ws://localhost:3001)');
  console.log('  --node-id <id>                       Node ID for worker mode (auto-generated if not provided)');
  console.log('  --node-name <name>                   Display name for worker mode');
  console.log('');
  console.log('Node Types:');
  console.log('  primary  - Self-contained node with both communication and execution');
  console.log('             Recommended for single-machine deployment');
  console.log('  worker   - Execution-only node that connects to Primary Node');
  console.log('             For horizontal scaling');
  console.log('');
  console.log('Channels (Primary Node):');
  console.log('  - Feishu: Enabled when feishu.appId and feishu.appSecret are configured');
  console.log('  - REST:   Enabled by default on port 3000, use --no-rest to disable');
  console.log('');
  console.log('Examples:');
  console.log('  # Single machine (recommended):');
  console.log('  disclaude start --mode primary');
  console.log('');
  console.log('  # With custom config file:');
  console.log('  disclaude start --mode primary --config /path/to/config.yaml');
  console.log('');
  console.log('  # Horizontal scaling (multiple workers):');
  console.log('  disclaude start --mode primary --port 3001');
  console.log('  disclaude start --mode worker --comm-url ws://primary:3001 --node-name worker-1');
  console.log('  disclaude start --mode worker --comm-url ws://primary:3001 --node-name worker-2');
  console.log('');
  console.log('REST API Endpoints (when REST channel is enabled):');
  console.log('  POST /api/chat          Send message (streaming response)');
  console.log('  POST /api/chat/sync     Send message (synchronous response)');
  console.log('  GET  /api/health        Health check');
  console.log('');
}

/**
 * Main CLI entry point with enhanced error handling.
 */
async function main(): Promise<void> {
  // Load all dependencies after config is set
  await loadDependencies();

  // Get logging config from file and apply log level
  const loggingConfig = Config.getLoggingConfig();
  // Set log level first (rootLogger may already be initialized by module imports)
  setLogLevel(loggingConfig.level as import('./utils/logger.js').LogLevel);
  const logger = await initLogger({
    level: loggingConfig.level as import('./utils/logger.js').LogLevel,
    metadata: {
      version: packageJson.version,
      nodeVersion: process.version,
      platform: process.platform
    }
  });
  logger.debug({ loggingConfig }, 'Logging configuration applied');

  const globalArgs = parseGlobalArgs();
  const { mode } = globalArgs;

  logger.info({
    mode,
    command: process.argv[2],
    args: process.argv.slice(3),
    configPath: configPath || 'auto-detect'
  }, 'Disclaude starting');

  // Change working directory to workspace directory
  const workspaceDir = Config.getWorkspaceDir();
  logger.info({ workspaceDir }, 'Changing working directory');
  process.chdir(workspaceDir);

  // Copy skills to workspace .claude/skills for SDK to load via settingSources
  try {
    const skillsResult = await setupSkillsInWorkspace();
    if (skillsResult.success) {
      logger.info('Skills copied to workspace .claude/skills');
    } else {
      logger.warn({ error: skillsResult.error }, 'Failed to copy skills to workspace, continuing anyway');
    }
  } catch (error) {
    // Don't fail the entire application if skills setup fails
    logger.warn({ err: error }, 'Failed to setup skills in workspace, continuing anyway');
  }

  try {
    // Dynamically import runners to avoid loading unnecessary modules
    const { runPrimaryNode, runWorkerNode } = await importRunners();

    // Show help if no command provided
    if (!process.argv[2] || process.argv[2] === '--help' || process.argv[2] === '-h') {
      showHelp();
      process.exit(0);
    }

    // Validate command
    if (process.argv[2] !== 'start') {
      handleError(new Error(`Unknown command "${process.argv[2]}"`), {
        category: ErrorCategory.VALIDATION,
        userMessage: `Unknown command "${process.argv[2]}". Use "disclaude start --mode <primary|worker>"`
      }, {
        log: true,
        throwOnError: true
      });
    }

    // Validate mode is provided
    if (!mode) {
      handleError(new Error('Mode is required'), {
        category: ErrorCategory.VALIDATION,
        userMessage: 'Mode is required. Use --mode <primary|worker>'
      }, {
        log: true,
        throwOnError: true
      });
    }

    // Validate agent configuration first
    try {
      Config.getAgentConfig();
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.CONFIGURATION,
        userMessage: 'Configuration error. Please check your disclaude.config.yaml file.'
      }, {
        log: true,
        throwOnError: true
      });
    }

    // Show header
    console.log('='.repeat(50));
    console.log(`  Disclaude - Agent Bot (${mode} mode)`);
    console.log('='.repeat(50));
    console.log();

    // Run based on mode
    switch (mode) {
      case 'primary':
        // Note: Feishu is optional now - REST channel can work without Feishu
        const hasFeishuPrimary = Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET;
        const hasRestPrimary = globalArgs.enableRestChannel !== false;

        if (!hasFeishuPrimary && !hasRestPrimary) {
          handleError(new Error('No communication channel configured'), {
            category: ErrorCategory.CONFIGURATION,
            userMessage: 'Primary Node requires at least one channel. Configure Feishu (feishu.appId and feishu.appSecret) or enable REST channel.'
          }, {
            log: true,
            throwOnError: true
          });
        }

        await runPrimaryNode();
        break;

      case 'worker':
        await runWorkerNode();
        break;

      default:
        handleError(new Error(`Unknown mode "${mode}"`), {
          category: ErrorCategory.VALIDATION,
          userMessage: `Unknown mode "${mode}". Available modes: primary, worker`
        }, {
          log: true,
          throwOnError: true
        });
    }
  } catch (error) {
    handleError(error, {
      category: ErrorCategory.UNKNOWN,
      userMessage: 'An unexpected error occurred'
    }, {
      log: true,
      throwOnError: true
    });
  }
}

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  // Ensure dependencies are loaded before using them
  if (!flushLogger) {
    await loadDependencies();
  }
  const logger = await initLogger();
  logger.info('Received SIGINT, shutting down gracefully');

  console.log('\nGoodbye!');

  // Flush any pending logs
  await flushLogger();

  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  // Ensure dependencies are loaded before using them
  if (!getRootLogger) {
    await loadDependencies();
  }
  const logger = getRootLogger();
  logger.fatal({ err: error }, 'Uncaught exception');
  void flushLogger().finally(() => process.exit(1));
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  // Use console as fallback if logger not initialized
  if (!getRootLogger || !flushLogger) {
    console.error('Unhandled promise rejection:', reason);
    process.exit(1);
    return;
  }
  const logger = getRootLogger();
  logger.fatal({ err: reason, promise }, 'Unhandled promise rejection');
  void flushLogger().finally(() => process.exit(1));
});

// Run main with error handling
main().catch(async (error) => {
  // Ensure dependencies are loaded before using them
  if (!initLogger || !flushLogger) {
    console.error('Fatal error in main:', error);
    process.exit(1);
    return;
  }
  const logger = await initLogger();
  logger.fatal({ err: error }, 'Fatal error in main');
  await flushLogger();
  process.exit(1);
});

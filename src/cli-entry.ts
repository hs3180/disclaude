/**
 * CLI entry point for Disclaude.
 *
 * Supports two modes:
 * - comm: Communication Node (multi-channel handler: Feishu, REST, etc.)
 * - exec: Execution Node (Pilot/Agent handler)
 */
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { parseGlobalArgs } from './utils/cli-args.js';
import packageJson from '../package.json' with { type: 'json' };

/**
 * Dynamic imports for runners to avoid loading unnecessary modules.
 * This ensures comm mode doesn't load the schedule module (issue #114).
 */
async function importRunners() {
  const runners = await import('./runners/index.js');
  return {
    runCommunicationNode: runners.runCommunicationNode,
    runExecutionNode: runners.runExecutionNode,
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
  console.log('  Version: ' + packageJson.version);
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('Usage:');
  console.log('  disclaude start --mode comm           Communication Node (Multi-channel)');
  console.log('  disclaude start --mode exec           Execution Node (Pilot Agent)');
  console.log('');
  console.log('Options:');
  console.log('  --mode <comm|exec>                    Select run mode (required for start)');
  console.log('  --port <port>                         WebSocket port for comm mode (default: 3001)');
  console.log('  --rest-port <port>                    REST API port for comm mode (default: 3000)');
  console.log('  --no-rest                             Disable REST channel');
  console.log('  --comm-url <url>                      Communication Node URL for exec mode (default: ws://localhost:3001)');
  console.log('');
  console.log('Channels (Communication Node):');
  console.log('  - Feishu: Enabled when feishu.appId and feishu.appSecret are configured');
  console.log('  - REST:   Enabled by default on port 3000, use --no-rest to disable');
  console.log('');
  console.log('Examples:');
  console.log('  # Communication Node (handles Feishu + REST, starts first)');
  console.log('  disclaude start --mode comm --port 3001 --rest-port 3000');
  console.log('');
  console.log('  # Execution Node (handles Agent tasks)');
  console.log('  disclaude start --mode exec --comm-url ws://localhost:3001');
  console.log('');
  console.log('REST API Endpoints (when REST channel is enabled):');
  console.log('  POST /api/chat          Send message (streaming response)');
  console.log('  POST /api/chat/sync     Send message (synchronous response)');
  console.log('  GET  /api/health        Health check');
  console.log('');
  console.log('For production deployment, run both nodes in separate processes:');
  console.log('  Process 1: disclaude start --mode comm');
  console.log('  Process 2: disclaude start --mode exec');
  console.log('');
}

/**
 * Main CLI entry point with enhanced error handling.
 */
async function main(): Promise<void> {
  const logger = await initLogger({
    metadata: {
      version: packageJson.version,
      nodeVersion: process.version,
      platform: process.platform
    }
  });

  const globalArgs = parseGlobalArgs();
  const { mode } = globalArgs;

  logger.info({
    mode,
    command: process.argv[2],
    args: process.argv.slice(3)
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
    // This ensures comm mode doesn't load the schedule module (issue #114)
    const { runCommunicationNode, runExecutionNode } = await importRunners();

    // Show help if no command provided
    if (!process.argv[2] || process.argv[2] === '--help' || process.argv[2] === '-h') {
      showHelp();
      process.exit(0);
    }

    // Validate command
    if (process.argv[2] !== 'start') {
      handleError(new Error(`Unknown command "${process.argv[2]}"`), {
        category: ErrorCategory.VALIDATION,
        userMessage: `Unknown command "${process.argv[2]}". Use "disclaude start --mode <comm|exec>"`
      }, {
        log: true,
        throwOnError: true
      });
    }

    // Validate mode is provided
    if (!mode) {
      handleError(new Error('Mode is required'), {
        category: ErrorCategory.VALIDATION,
        userMessage: 'Mode is required. Use --mode <comm|exec>'
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
      case 'comm':
        // Note: Feishu is optional now - REST channel can work without Feishu
        const hasFeishu = Config.FEISHU_APP_ID && Config.FEISHU_APP_SECRET;
        const hasRest = globalArgs.enableRestChannel !== false;

        if (!hasFeishu && !hasRest) {
          handleError(new Error('No communication channel configured'), {
            category: ErrorCategory.CONFIGURATION,
            userMessage: 'Communication Node requires at least one channel. Configure Feishu (feishu.appId and feishu.appSecret) or enable REST channel.'
          }, {
            log: true,
            throwOnError: true
          });
        }

        await runCommunicationNode();
        break;

      case 'exec':
        await runExecutionNode();
        break;

      default:
        handleError(new Error(`Unknown mode "${mode}"`), {
          category: ErrorCategory.VALIDATION,
          userMessage: `Unknown mode "${mode}". Available modes: comm, exec`
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
  const logger = await initLogger();
  logger.info('Received SIGINT, shutting down gracefully');

  console.log('\nGoodbye!');

  // Flush any pending logs
  await flushLogger();

  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  const logger = getRootLogger();
  logger.fatal({ err: error }, 'Uncaught exception');
  void flushLogger().finally(() => process.exit(1));
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  const logger = getRootLogger();
  logger.fatal({ err: reason, promise }, 'Unhandled promise rejection');
  void flushLogger().finally(() => process.exit(1));
});

// Run main with error handling
main().catch(async (error) => {
  const logger = await initLogger();
  logger.fatal({ err: error }, 'Fatal error in main');
  await flushLogger();
  process.exit(1);
});

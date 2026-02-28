/**
 * CLI entry point for Disclaude.
 *
 * Supports two modes:
 * - primary: Primary Node (comm + exec, recommended for single-machine)
 * - worker: Worker Node (exec only, connects to Primary)
 */
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { parseGlobalArgs } from './utils/cli-args.js';
import packageJson from '../package.json' with { type: 'json' };

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

// Note: SIGINT/SIGTERM handling is delegated to individual runners.
// This avoids duplicate handlers and ensures proper cleanup of runner resources.
// Each runner (primary-runner, worker-runner, etc.) registers its own signal handlers.

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

/**
 * CLI entry point for Disclaude.
 *
 * Supports two modes:
 * - comm: Communication Node (Feishu WebSocket handler)
 * - exec: Execution Node (Pilot/Agent handler)
 */
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { parseGlobalArgs } from './utils/cli-args.js';
import { runCommunicationNode, runExecutionNode, runCli } from './runners/index.js';
import packageJson from '../package.json' with { type: 'json' };

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
  console.log('  disclaude start --mode comm           Communication Node (Feishu WebSocket)');
  console.log('  disclaude start --mode exec           Execution Node (Pilot Agent)');
  console.log('  disclaude --prompt <msg>              Execute single prompt');
  console.log('');
  console.log('Options:');
  console.log('  --mode <comm|exec>                    Select run mode (required for start)');
  console.log('  --port <port>                         Port for exec mode (default: 3002)');
  console.log('  --execution-url <url>                 Execution Node URL for comm mode (default: ws://localhost:3002)');
  console.log('  --feishu-chat-id <id>                 Send CLI output to Feishu chat');
  console.log('');
  console.log('Examples:');
  console.log('  # Execution Node (handles Agent tasks, starts first)');
  console.log('  disclaude start --mode exec --port 3002');
  console.log('');
  console.log('  # Communication Node (handles Feishu connection)');
  console.log('  disclaude start --mode comm --execution-url ws://localhost:3002');
  console.log('');
  console.log('  # CLI prompt mode');
  console.log('  disclaude --prompt "What is the weather today?"');
  console.log('');
  console.log('For production deployment, run both nodes in separate processes:');
  console.log('  Process 1: disclaude start --mode exec');
  console.log('  Process 2: disclaude start --mode comm');
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
  const { mode, promptMode, promptArgs } = globalArgs;

  logger.info({
    mode,
    promptMode,
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
    // Handle prompt mode (CLI single query)
    if (promptMode) {
      await runCli(promptArgs);
      return;
    }

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
        // Validate Feishu config for comm mode
        if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
          handleError(new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required'), {
            category: ErrorCategory.CONFIGURATION,
            userMessage: 'Communication Node requires Feishu configuration. Please set feishu.appId and feishu.appSecret in your disclaude.config.yaml file.'
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

/**
 * CLI entry point for Disclaude.
 *
 * Supports three modes:
 * - single: Single process mode (default, backward compatible)
 * - comm: Communication Node only (Feishu WebSocket handler)
 * - exec: Execution Node only (Pilot/Agent handler)
 */
import { runFeishu } from './bots.js';
import { runCli } from './cli/index.js';
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { runCommunicationNode, runExecutionNode } from './runners/index.js';
import packageJson from '../package.json' with { type: 'json' };
import type { RunMode } from './config/types.js';

// Increase max listeners to prevent memory leak warnings
// We register multiple process event handlers across the codebase
process.setMaxListeners(20);

/**
 * Parse command line arguments.
 */
function parseArgs(): { mode: RunMode; promptMode: boolean; promptArgs: string[] } {
  const args = process.argv.slice(2);

  // Check for prompt mode
  const promptIndex = args.indexOf('--prompt');
  if (promptIndex !== -1) {
    return { mode: 'single', promptMode: true, promptArgs: args };
  }

  // Check for start command with mode
  if (args[0] === 'start') {
    const modeIndex = args.indexOf('--mode');
    if (modeIndex !== -1 && args[modeIndex + 1]) {
      const mode = args[modeIndex + 1] as RunMode;
      if (['single', 'comm', 'exec'].includes(mode)) {
        return { mode, promptMode: false, promptArgs: [] };
      }
    }
    // Default mode for 'start' command
    return { mode: 'single', promptMode: false, promptArgs: [] };
  }

  // Legacy: 'feishu' command is equivalent to 'start --mode single'
  if (args[0] === 'feishu') {
    return { mode: 'single', promptMode: false, promptArgs: [] };
  }

  return { mode: 'single', promptMode: false, promptArgs: args };
}

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
  console.log('  disclaude start                       Start in single process mode (default)');
  console.log('  disclaude start --mode single         Single process mode (Feishu + Agent)');
  console.log('  disclaude start --mode comm           Communication Node only (Feishu)');
  console.log('  disclaude start --mode exec           Execution Node only (Agent)');
  console.log('  disclaude --prompt <msg>              Execute single prompt in CLI');
  console.log('');
  console.log('Options:');
  console.log('  --mode <single|comm|exec>             Select run mode');
  console.log('  --port <port>                         Port for comm/exec mode (default: 3001)');
  console.log('  --host <host>                         Host for comm mode (default: 0.0.0.0)');
  console.log('  --communication-url <url>             Communication Node URL for exec mode');
  console.log('  --feishu-chat-id <id>                 Send CLI output to Feishu chat');
  console.log('');
  console.log('Examples:');
  console.log('  # Single process mode (all-in-one)');
  console.log('  disclaude start');
  console.log('  disclaude start --mode single');
  console.log('');
  console.log('  # Distributed mode - Communication Node');
  console.log('  disclaude start --mode comm --port 3001');
  console.log('');
  console.log('  # Distributed mode - Execution Node');
  console.log('  disclaude start --mode exec --communication-url http://localhost:3001');
  console.log('');
  console.log('  # CLI prompt mode');
  console.log('  disclaude --prompt "What is the weather today?"');
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

  const { mode, promptMode, promptArgs } = parseArgs();

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

    // Validate unknown command
    const validCommands = ['start', 'feishu', '--prompt', '--help', '-h'];
    if (!validCommands.includes(process.argv[2])) {
      handleError(new Error(`Unknown command "${process.argv[2]}"`), {
        category: ErrorCategory.VALIDATION,
        userMessage: `Unknown command "${process.argv[2]}"`
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
      case 'single':
        // Validate Feishu config for single mode
        if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
          handleError(new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required'), {
            category: ErrorCategory.CONFIGURATION,
            userMessage: 'Feishu configuration is incomplete. Please set feishu.appId and feishu.appSecret in your disclaude.config.yaml file.'
          }, {
            log: true,
            throwOnError: true
          });
        }
        await runFeishu();
        break;

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
          userMessage: `Unknown mode "${mode}". Available modes: single, comm, exec`
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

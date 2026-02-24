/**
 * CLI entry point for Disclaude.
 *
 * Supports two modes:
 * - comm: Communication Node (Feishu WebSocket handler)
 * - exec: Execution Node (Pilot/Agent handler)
 *
 * Supports schedule commands:
 * - schedule:list - List all scheduled tasks
 * - schedule:start - Start the scheduler
 * - schedule:stop - Stop the scheduler
 * - schedule:run - Manually run a scheduled task
 */
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { parseGlobalArgs } from './utils/cli-args.js';
import { runCommunicationNode, runExecutionNode, runCli } from './runners/index.js';
import { getGlobalScheduler } from './scheduler/index.js';
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
  console.log('  disclaude schedule:list               List all scheduled tasks');
  console.log('  disclaude schedule:start              Start the scheduler');
  console.log('  disclaude schedule:stop               Stop the scheduler');
  console.log('  disclaude schedule:run <name>         Manually run a scheduled task');
  console.log('');
  console.log('Options:');
  console.log('  --mode <comm|exec>                    Select run mode (required for start)');
  console.log('  --port <port>                         Port for comm mode (default: 3001)');
  console.log('  --comm-url <url>                      Communication Node URL for exec mode (default: ws://localhost:3001)');
  console.log('  --feishu-chat-id <id>                 Send CLI output to Feishu chat');
  console.log('');
  console.log('Examples:');
  console.log('  # Communication Node (handles Feishu connection, starts first)');
  console.log('  disclaude start --mode comm --port 3001');
  console.log('');
  console.log('  # Execution Node (handles Agent tasks)');
  console.log('  disclaude start --mode exec --comm-url ws://localhost:3001');
  console.log('');
  console.log('  # CLI prompt mode');
  console.log('  disclaude --prompt "What is the weather today?"');
  console.log('');
  console.log('  # Scheduler commands');
  console.log('  disclaude schedule:list');
  console.log('  disclaude schedule:start');
  console.log('  disclaude schedule:run daily-report');
  console.log('');
  console.log('For production deployment, run both nodes in separate processes:');
  console.log('  Process 1: disclaude start --mode comm');
  console.log('  Process 2: disclaude start --mode exec');
  console.log('');
}

/**
 * Handle scheduler commands.
 *
 * @param command - Schedule command to execute
 * @param args - Command arguments
 */
async function handleScheduleCommand(command: string, args: string[]): Promise<void> {
  await initLogger();
  const scheduler = getGlobalScheduler();

  // Load scheduler configuration
  const schedulerConfig = Config.getSchedulerConfig();
  if (schedulerConfig) {
    scheduler.loadSchedules(schedulerConfig);
  }

  switch (command) {
    case 'schedule:list': {
      console.log('');
      console.log('═══════════════════════════════════════════════════');
      console.log('  Scheduled Tasks');
      console.log('═══════════════════════════════════════════════════');
      console.log('');

      const stats = scheduler.getTaskStats();

      if (stats.length === 0) {
        console.log('  No scheduled tasks configured.');
        console.log('');
        console.log('  Add schedules to your disclaude.config.yaml:');
        console.log('');
        console.log('  scheduler:');
        console.log('    enabled: true');
        console.log('    schedules:');
        console.log('      - name: "daily-report"');
        console.log('        cron: "0 9 * * *"');
        console.log('        args: "Generate daily report"');
        console.log('        enabled: true');
        console.log('');
      } else {
        console.log(`  Total: ${stats.length} task(s)`);
        console.log(`  Status: ${scheduler.isActive() ? 'Running' : 'Stopped'}`);
        console.log('');

        for (const stat of stats) {
          console.log(`  Task: ${stat.name}`);
          console.log(`    Runs: ${stat.runCount}`);
          console.log(`    Status: ${stat.isRunning ? 'Running' : 'Idle'}`);
          if (stat.lastRun) {
            console.log(`    Last Run: ${stat.lastRun.toLocaleString()}`);
          }
          if (stat.nextRun) {
            console.log(`    Next Run: ${stat.nextRun.toLocaleString()}`);
          }
          if (stat.lastError) {
            console.log(`    Last Error: ${stat.lastError}`);
          }
          console.log('');
        }
      }
      console.log('═══════════════════════════════════════════════════');
      console.log('');
      break;
    }

    case 'schedule:start': {
      console.log('');
      console.log('Starting scheduler...');

      if (scheduler.isActive()) {
        console.log('Scheduler is already running.');
      } else {
        scheduler.start();
        console.log(`Scheduler started with ${scheduler.getScheduleCount()} task(s).`);
      }
      console.log('');
      break;
    }

    case 'schedule:stop': {
      console.log('');
      console.log('Stopping scheduler...');

      if (!scheduler.isActive()) {
        console.log('Scheduler is not running.');
      } else {
        scheduler.stop();
        console.log('Scheduler stopped.');
      }
      console.log('');
      break;
    }

    case 'schedule:run': {
      const taskName = args[0];
      if (!taskName) {
        console.error('Error: Task name is required.');
        console.error('Usage: disclaude schedule:run <task-name>');
        process.exit(1);
      }

      console.log(`Running task: ${taskName}`);
      try {
        await scheduler.runTask(taskName);
        console.log('Task completed.');
      } catch (error) {
        const err = error as Error;
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
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

    // Handle schedule commands
    const command = process.argv[2];
    if (command === 'schedule:list' || command === 'schedule:start' ||
        command === 'schedule:stop' || command === 'schedule:run') {
      await handleScheduleCommand(command, process.argv.slice(3));
      return;
    }

    // Validate command
    if (command !== 'start') {
      handleError(new Error(`Unknown command "${command}"`), {
        category: ErrorCategory.VALIDATION,
        userMessage: `Unknown command "${command}". Use "disclaude start --mode <comm|exec>" or "disclaude schedule:*" commands`
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

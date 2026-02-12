/**
 * CLI entry point for Disclaude.
 * Supports bot mode (feishu) and prompt mode (--prompt).
 */
import { runFeishu } from './bots.js';
import { runCli } from './cli/index.js';
import { Config } from './config/index.js';
import { initLogger, flushLogger, getRootLogger } from './utils/logger.js';
import { handleError, ErrorCategory } from './utils/error-handler.js';
import { loadEnvironmentScripts } from './utils/env-loader.js';
import { setupSkillsInWorkspace } from './utils/skills-setup.js';
import { initializeSdkEnvironment, getSdkEnvironmentStatus } from './utils/sdk-env-init.js';
import packageJson from '../package.json' with { type: 'json' };

// Increase max listeners to prevent memory leak warnings
// We register multiple process event handlers across the codebase
process.setMaxListeners(20);

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

  logger.info({
    command: process.argv[2],
    args: process.argv.slice(3)
  }, 'Disclaude starting');

  // Change working directory to workspace directory
  const workspaceDir = Config.getWorkspaceDir();
  logger.info({ workspaceDir }, 'Changing working directory');
  process.chdir(workspaceDir);

  // Initialize SDK environment (create required directories)
  const sdkStatus = getSdkEnvironmentStatus();
  logger.debug({
    managedSkillsExists: sdkStatus.managedSkillsExists,
    userSkillsExists: sdkStatus.userSkillsExists,
    platform: sdkStatus.platform,
  }, 'SDK environment status check');

  if (!sdkStatus.managedSkillsExists && !sdkStatus.userSkillsExists) {
    logger.info('SDK environment not initialized, setting up required directories...');
    try {
      const sdkInitResult = await initializeSdkEnvironment(workspaceDir);
      if (sdkInitResult.success) {
        logger.info(
          {
            directoriesCreated: sdkInitResult.directoriesCreated,
            errors: sdkInitResult.errors,
          },
          'SDK environment initialized successfully'
        );
      } else {
        logger.warn(
          { errors: sdkInitResult.errors },
          'SDK environment initialization had errors, but continuing anyway'
        );
      }
    } catch (error) {
      // Don't fail the entire application if SDK init fails
      logger.warn({ err: error }, 'Failed to initialize SDK environment, continuing anyway');
    }
  }

  // Load environment scripts (.disclauderc, .env.sh) before main logic
  try {
    const envResult = await loadEnvironmentScripts();
    if (envResult.success) {
      logger.info(
        {
          script: envResult.scriptName,
          varsLoaded: envResult.envCount,
        },
        'Environment initialization script loaded'
      );
    }
  } catch (error) {
    // Don't fail the entire application if env loading fails
    logger.warn({ err: error }, 'Failed to load environment scripts, continuing anyway');
  }

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
    const args = process.argv.slice(2);

    // Check if prompt mode is requested
    const promptIndex = args.indexOf('--prompt');
    if (promptIndex !== -1) {
      // Pass all args to runCli, not just --prompt
      await runCli(args);
      return;
    }

    // Bot mode: parse platform argument
    const [platform] = args;

    if (!platform) {
      console.log('');
      console.log('═══════════════════════════════════════════════════');
      console.log('  Disclaude - Multi-platform Agent Bot');
      console.log('═══════════════════════════════════════════════════');
      console.log('');
      console.log('Usage:');
      console.log('  disclaude feishu           Start Feishu/Lark bot');
      console.log('  disclaude --prompt <msg>   Execute single prompt');
      console.log('');
      console.log('Options:');
      console.log('  --feishu-chat-id <id>     Send CLI output to Feishu chat');
      console.log('');
      process.exit(1);
    }

    // Validate agent configuration first
    try {
      Config.getAgentConfig();
    } catch (error) {
      handleError(error, {
        category: ErrorCategory.CONFIGURATION,
        userMessage: 'Configuration error. Please check your .env file.'
      }, {
        log: true,
        throwOnError: true
      });
    }

    // Show header
    console.log('='.repeat(50));
    console.log('  Disclaude - Agent Bot');
    console.log('='.repeat(50));
    console.log();

    // Run the selected platform
    if (platform === 'feishu') {
      // Validate Feishu config
      if (!Config.FEISHU_APP_ID || !Config.FEISHU_APP_SECRET) {
        handleError(new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required'), {
          category: ErrorCategory.CONFIGURATION,
          userMessage: 'Feishu configuration is incomplete. Please set FEISHU_APP_ID and FEISHU_APP_SECRET in your .env file.'
        }, {
          log: true,
          throwOnError: true
        });
      }
      await runFeishu();
    } else {
      handleError(new Error(`Unknown platform "${platform}"`), {
        category: ErrorCategory.VALIDATION,
        userMessage: `Unknown platform "${platform}". Available platforms: feishu`
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

/**
 * Integration Test Logger Setup
 *
 * This script initializes logging for integration tests with:
 * - Dedicated log directory (./logs/integration-tests by default)
 * - Configurable log level via LOG_LEVEL environment variable
 * - File logging enabled even in test environment
 *
 * Usage:
 *   1. As vitest setup file:
 *      // vitest.config.ts
 *      export default defineConfig({
 *        test: {
 *          setupFiles: ['./scripts/integration-test-setup.ts'],
 *        }
 *      });
 *
 *   2. Via environment variables (for shell-based integration tests):
 *      INTEGRATION_TEST=true LOG_DIR=./logs/integration-tests LOG_LEVEL=debug npm run test:integration
 *
 * Environment Variables:
 *   - INTEGRATION_TEST: Set to 'true' to enable file logging in test environment
 *   - LOG_DIR: Directory for log files (default: ./logs/integration-tests)
 *   - LOG_LEVEL: Log level (default: debug)
 *
 * Related: Issue #464 - 优化集成测试时的日志配置
 */

import { initLogger, resetLogger, setLogLevel } from '../src/utils/logger';

// Default log directory for integration tests
const DEFAULT_LOG_DIR = './logs/integration-tests';
const DEFAULT_LOG_LEVEL = 'debug';

/**
 * Initialize logger for integration tests
 */
export async function setupIntegrationTestLogging(): Promise<void> {
  // Reset any existing logger
  resetLogger();

  // Get configuration from environment variables
  const logDir = process.env.LOG_DIR ?? DEFAULT_LOG_DIR;
  const logLevel = (process.env.LOG_LEVEL as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal') ?? DEFAULT_LOG_LEVEL;

  // Initialize logger with file logging enabled
  await initLogger({
    level: logLevel,
    fileLogging: true,
    logDir,
    prettyPrint: false, // Use JSON format for machine parsing
    metadata: {
      testType: 'integration',
      testRun: new Date().toISOString(),
    },
  });

  // Log startup message
  const logger = await import('../src/utils/logger').then(m => m.createLogger('IntegrationTestSetup'));
  logger.info({ logDir, logLevel }, 'Integration test logging initialized');
}

/**
 * Update log level at runtime
 */
export function setIntegrationTestLogLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'): void {
  setLogLevel(level);
}

// Auto-setup when run directly or imported as setup file
let isSetup = false;

export async function ensureSetup(): Promise<void> {
  if (isSetup) return;
  isSetup = true;

  // Set INTEGRATION_TEST flag to enable file logging
  process.env.INTEGRATION_TEST = 'true';

  await setupIntegrationTestLogging();
}

// For vitest setupFiles - runs before all tests
if (process.env.VITEST === 'true' || process.argv.includes('--run')) {
  ensureSetup().catch(err => {
    console.error('Failed to setup integration test logging:', err);
  });
}

// Export for programmatic use
export default {
  setupIntegrationTestLogging,
  setIntegrationTestLogLevel,
  ensureSetup,
};

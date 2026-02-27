/**
 * Integration test setup and environment validation.
 *
 * This file runs before all integration tests and:
 * 1. Checks for required environment variables
 * 2. Skips tests if credentials are not available
 * 3. Sets up shared test utilities
 */

/**
 * Check if a set of environment variables are available.
 * Returns true if all are present, false otherwise.
 */
export function hasEnvVars(vars: string[]): boolean {
  return vars.every((v) => process.env[v] && process.env[v]!.length > 0);
}

/**
 * Skip describe block if environment variables are not available.
 * Use this to wrap integration tests that require specific credentials.
 */
export function describeIfEnvVars(
  name: string,
  requiredVars: string[],
  fn: () => void
): void {
  if (hasEnvVars(requiredVars)) {
    describe(name, fn);
  } else {
    describe.skip(`${name} (missing env vars: ${requiredVars.join(', ')})`, fn);
  }
}

/**
 * Generate a unique test identifier for isolation.
 */
export function testId(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Wait for a condition to be true, with timeout.
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; interval?: number } = {}
): Promise<void> {
  const { timeout = 5000, interval = 100 } = options;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`Timeout waiting for condition after ${timeout}ms`);
}

// Log test environment status
beforeAll(() => {
  console.log('\n📋 Integration Test Environment:');
  console.log(`  FEISHU_APP_ID: ${process.env.FEISHU_APP_ID ? '✅ set' : '❌ not set'}`);
  console.log(`  FEISHU_APP_SECRET: ${process.env.FEISHU_APP_SECRET ? '✅ set' : '❌ not set'}`);
  console.log(`  ANTHROPIC_API_KEY: ${process.env.ANTHROPIC_API_KEY ? '✅ set' : '❌ not set'}`);
  console.log('');
});

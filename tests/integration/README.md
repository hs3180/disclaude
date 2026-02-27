# Integration Tests

This directory contains integration tests that verify the system works correctly with real external services.

## Test Categories

### 1. Feishu API Integration (`feishu-api.test.ts`)

Tests real Feishu API interactions:
- Tenant access token acquisition
- Message sending capabilities
- User info retrieval
- Error handling with real API responses

### 2. MCP Tools Integration (`mcp-tools.test.ts`)

Tests MCP protocol communication:
- MCP server initialization and handshake
- Tool discovery and listing
- Tool execution with real implementations
- Error handling in tool execution
- MCP protocol compliance

### 3. Node Communication Integration (`node-communication.test.ts`)

Tests inter-node communication:
- File storage and retrieval between nodes
- File API operations
- Transfer protocol compliance
- Error handling in distributed scenarios

## Running Tests

### Prerequisites

Set the required environment variables:

```bash
# For Feishu API tests
export FEISHU_APP_ID="your_app_id"
export FEISHU_APP_SECRET="your_app_secret"

# For Claude SDK tests (if needed)
export ANTHROPIC_API_KEY="your_api_key"
```

### Run All Integration Tests

```bash
npm run test:integration
```

### Run Specific Test File

```bash
npx vitest run --config vitest.integration.config.ts tests/integration/feishu-api.test.ts
```

## Test Behavior

### Graceful Skipping

Tests that require missing credentials will be **automatically skipped**. This allows running integration tests in CI environments without all credentials.

Example output:
```
📋 Integration Test Environment:
  FEISHU_APP_ID: ❌ not set
  FEISHU_APP_SECRET: ❌ not set
  ANTHROPIC_API_KEY: ✅ set

✓ MCP Tool Definitions (3 tests)
✓ MCP Error Handling (3 tests)
↓ Feishu API Integration (missing env vars: FEISHU_APP_ID, FEISHU_APP_SECRET) (skipped)
```

### Timeouts

Integration tests have a 60-second timeout per test (vs. 10 seconds for unit tests) to accommodate network latency and API response times.

## CI Integration

For CI pipelines, integration tests can be run conditionally:

```yaml
# GitHub Actions example
- name: Run Integration Tests
  if: ${{ secrets.FEISHU_APP_ID && secrets.FEISHU_APP_SECRET }}
  env:
    FEISHU_APP_ID: ${{ secrets.FEISHU_APP_ID }}
    FEISHU_APP_SECRET: ${{ secrets.FEISHU_APP_SECRET }}
  run: npm run test:integration
```

## Writing New Integration Tests

1. Create a new test file in this directory
2. Import `describeIfEnvVars` from `./setup.js` for tests requiring credentials
3. Use `testId()` to generate unique identifiers for test isolation
4. Document required environment variables at the top of the file

Example:

```typescript
import { describe, it, expect } from 'vitest';
import { describeIfEnvVars, testId } from './setup.js';

const REQUIRED_VARS = ['MY_API_KEY'];

describeIfEnvVars('My Integration Tests', REQUIRED_VARS, () => {
  it('should work with real API', async () => {
    // Your test code here
  });
});
```

## Related

- Issue #288: Integration & E2E Test Coverage
- Milestone: 0.3.3

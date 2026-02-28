# Integration Tests

This directory contains integration tests for the Disclaude project.

## Test Environment Setup

### 1. Create Test Configuration

```bash
cp tests/integration/test-env.example.yaml tests/integration/test-env.yaml
```

Edit `test-env.yaml` with your actual API keys for testing.

### 2. Build the Project

```bash
npm run build
```

### 3. Start the Test Server

Start the Communication Node with REST Channel:

```bash
node dist/cli-entry.js start --mode comm --rest-port 3099 --host 127.0.0.1
```

### 4. Run Integration Tests

```bash
./tests/integration/rest-channel-test.sh
```

Or use npm script:

```bash
npm run test:integration
```

## Available Tests

### REST Channel Tests (`rest-channel-test.sh`)

Tests the REST Channel functionality:

- **Health Check**: Verifies `/api/health` endpoint returns 200
- **Chat Endpoint (Async)**: Tests valid message submission
- **Error Handling**: Tests 400 responses for invalid requests
- **CORS Support**: Verifies CORS headers are present
- **Custom ChatId**: Tests custom chat ID preservation
- **Unknown Routes**: Tests 404 responses

## Test Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `REST_PORT` | 3099 | REST API port for testing |
| `HOST` | 127.0.0.1 | Test server host |
| `TIMEOUT` | 10 | Request timeout in seconds |

## CI/CD Integration

Integration tests are automatically run in GitHub Actions:

1. **PR Tests**: Run on all pull requests to main/master
2. **Push Tests**: Run on pushes to main/master
3. **Test Reports**: Artifacts are uploaded on failure

## Adding New Tests

To add a new integration test:

1. Create a new test script in `tests/integration/`
2. Follow the existing pattern with helper functions
3. Add the test to CI workflow if needed
4. Update this README

## Test Data

Test data is stored in `tests/integration/workspace/` and is automatically
cleaned up after tests if `cleanupAfterTest: true` is set in config.

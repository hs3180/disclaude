# Integration Tests

This directory contains integration tests for the Disclaude project.

## Test Environment Setup

### 1. Build the Project

```bash
npm run build
```

### 2. Start the Test Server

Start the Primary Node with REST Channel:

```bash
node dist/cli-entry.js start --mode primary --rest-port 3099 --host 127.0.0.1
```

With a custom config file:

```bash
node dist/cli-entry.js start --mode primary --rest-port 3099 --config ./path/to/disclaude.config.yaml
```

### 3. Run Integration Tests

```bash
./tests/integration/rest-channel-test.sh
```

Or use npm script:

```bash
npm run test:integration
```

## Configuration

Integration tests are configured via **environment variables**:

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DISCLAUDE_CONFIG` | (auto-detect) | Path to config file (passed to --config) |
| `REST_PORT` | 3099 | REST API port for testing |
| `HOST` | 127.0.0.1 | Test server host |
| `TIMEOUT` | 10 | Request timeout in seconds |

Example:

```bash
REST_PORT=3099 HOST=127.0.0.1 ./tests/integration/rest-channel-test.sh
```

With custom config:

```bash
DISCLAUDE_CONFIG=./test-config.yaml ./tests/integration/rest-channel-test.sh
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

## Adding New Tests

To add a new integration test:

1. Create a new test script in `tests/integration/`
2. Follow the existing pattern with helper functions
3. Update this README

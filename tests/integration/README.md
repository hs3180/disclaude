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

### Use Case 3: Multi-turn Conversation (`use-case-3-multi-turn.sh`)

Tests multi-turn conversation with context preservation:
- User sends multiple messages in sequence
- Agent maintains context across turns
- Agent can reference previous messages
- Different chat IDs maintain separate contexts

**Test Scenarios:**
1. **Number Context Test**: Set a favorite number, ask about it, then ask for a calculation
2. **Name Context Test**: Introduce with name and interest, ask about each
3. **Separate Chat Test**: Verify different chat IDs don't share context

**Usage:**
```bash
./tests/integration/use-case-3-multi-turn.sh
```

**Options:**
- `--timeout SECONDS` - Maximum wait time for response (default: 180)
- `--port PORT` - REST API port (default: 3000)
- `--verbose` - Enable verbose output
- `--dry-run` - Show test plan without executing

## Adding New Tests

To add a new integration test:

1. Create a new test script in `tests/integration/`
2. Follow the existing pattern with helper functions
3. Update this README

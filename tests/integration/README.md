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

### Use Case 1 - Basic Reply (`use-case-1-basic-reply.sh`)

Tests the most basic conversation scenario:

- **Health Check**: Verifies server is running
- **Basic Greeting**: Agent responds to "你好"
- **Custom ChatId**: Verifies chatId preservation

```bash
./tests/integration/use-case-1-basic-reply.sh
```

Options:
- `--timeout SECONDS`: Maximum wait time for response (default: 180)
- `--port PORT`: REST API port (default: 3000)
- `--verbose`: Enable verbose output
- `--dry-run`: Show test plan without executing

### Use Case 2 - Task Execution (`use-case-2-task-execution.sh`)

Tests task execution scenario: User sends a task, Agent executes and returns result.

- **Health Check**: Verifies server is running
- **Calculation Task**: Agent computes 25 * 17
- **File Listing Task**: Agent lists directory contents
- **Text Analysis Task**: Agent summarizes text

```bash
./tests/integration/use-case-2-task-execution.sh
```

Options:
- `--timeout SECONDS`: Maximum wait time for response (default: 60)
- `--port PORT`: REST API port (default: 3099)
- `--verbose`: Enable verbose output
- `--dry-run`: Show test plan without executing

### Use Case 3 - Multi-turn Conversation (`use-case-3-multi-turn.sh`)

Tests multi-turn conversation scenarios with context preservation:

- **Health Check**: Verifies server is running
- **Number Context**: Set favorite number, recall it, and calculate with it
- **Name Context**: Introduce name and profession, then recall each
- **Context Isolation**: Verify different chatId don't share context

```bash
./tests/integration/use-case-3-multi-turn.sh
```

Options:
- `--timeout SECONDS`: Maximum wait time for response (default: 60)
- `--port PORT`: REST API port (default: 3099)
- `--verbose`: Enable verbose output
- `--dry-run`: Show test plan without executing

## Adding New Tests

To add a new integration test:

1. Create a new test script in `tests/integration/`
2. Follow the existing pattern with helper functions
3. Update this README

# Integration Tests

This directory contains integration tests for the Disclaude project.

## Test Framework Architecture

The integration tests use a shared test environment library:

```
tests/integration/
├── test-env.sh                    # Common test environment library
├── rest-channel-test.sh           # REST Channel API tests
├── use-case-2-task-execution.sh   # Use Case 2: Task execution tests
└── use-case-3-multi-turn.sh       # Use Case 3: Multi-turn conversation tests
```

### Common Test Environment (`test-env.sh`)

The `test-env.sh` script provides common functions for all integration tests:

- **Server Management**: `start_server`, `stop_server`, `ensure_server_running`
- **HTTP Helpers**: `make_request`, `send_chat_message`, `wait_for_reply`
- **Logging**: `log_info`, `log_pass`, `log_fail`, `log_skip`, `log_section`
- **Utilities**: `generate_chat_id`, `check_prerequisites`, `print_summary`

To use it in a new test script:

```bash
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/test-env.sh"

# Parse common arguments
parse_common_args "$@"

# Your test functions here...
```

## Test Environment Setup

### 1. Build the Project

```bash
npm run build
```

### 2. Run Tests

Tests will automatically start the server if needed:

```bash
# REST Channel tests
./tests/integration/rest-channel-test.sh

# Use Case 2: Task execution
./tests/integration/use-case-2-task-execution.sh

# Use Case 3: Multi-turn conversation
./tests/integration/use-case-3-multi-turn.sh
```

Or use npm script:

```bash
npm run test:integration
```

## Command Line Options

All test scripts support common options:

| Option | Description |
|--------|-------------|
| `--verbose, -v` | Enable verbose output |
| `--timeout, -t SECS` | Request timeout (default: 30) |
| `--port, -p PORT` | REST API port (default: 3099) |
| `--config, -c PATH` | Config file path |
| `--dry-run` | Show configuration without running |
| `--help, -h` | Show help |

Examples:

```bash
# Verbose mode
./tests/integration/use-case-2-task-execution.sh --verbose

# Custom port and timeout
./tests/integration/use-case-3-multi-turn.sh --port 3001 --timeout 120

# With config file
./tests/integration/rest-channel-test.sh --config ./test-config.yaml
```

## Configuration

Integration tests are configured via **environment variables**:

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `DISCLAUDE_CONFIG` | (auto-detect) | Path to config file (passed to --config) |
| `REST_PORT` | 3099 | REST API port for testing |
| `HOST` | 127.0.0.1 | Test server host |
| `TIMEOUT` | 30 | Request timeout in seconds |
| `VERBOSE` | false | Enable verbose output |

Example:

```bash
REST_PORT=3099 HOST=127.0.0.1 TIMEOUT=60 ./tests/integration/use-case-2-task-execution.sh
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

### Use Case 2: Task Execution (`use-case-2-task-execution.sh`)

Tests task execution scenario - user sends a task, agent executes and returns result:

- **Calculation Task**: Agent performs mathematical calculation
- **File System Task**: Agent lists directory contents
- **Analysis Task**: Agent analyzes and summarizes text

**Acceptance Criteria** (Issue #330):
- [x] Use REST Channel to send task
- [x] Agent correctly parses task intent
- [x] Agent executes task (calls tools)
- [x] Result returned via REST Channel
- [x] Does not depend on vitest framework

### Use Case 3: Multi-turn Conversation (`use-case-3-multi-turn.sh`)

Tests multi-turn conversation with context preservation:

- **Number Context**: Set favorite number, recall it, use in calculation
- **Name Context**: Introduce name and interests, ask about each
- **Context Isolation**: Verify different chatIds have isolated contexts

**Acceptance Criteria** (Issue #331):
- [x] Use REST Channel for multi-turn conversation
- [x] Agent can reference first turn's info in second turn
- [x] Context is correctly passed
- [x] Does not depend on vitest framework

## Adding New Tests

To add a new integration test:

1. Create a new test script in `tests/integration/`
2. Source the common test environment:
   ```bash
   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
   source "${SCRIPT_DIR}/test-env.sh"
   parse_common_args "$@"
   ```
3. Use the provided helper functions
4. Update this README

## Prerequisites

- Node.js installed
- Project built (`npm run build`)
- Valid `disclaude.config.yaml` with AI provider configured
- Environment variable set (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)

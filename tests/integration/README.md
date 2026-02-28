# Integration Tests

This directory contains integration tests for disclaude that test the full system end-to-end.

## Test Cases

### Use Case 1: Basic Chat (`use-case-1-basic-chat.sh`)

Tests the most basic conversation scenario:
- User sends a message via REST Channel
- Agent receives the message and generates a reply
- Reply is returned through REST Channel

**Prerequisites:**
- Node.js installed
- disclaude built (`npm run build`)
- Valid `disclaude.config.yaml` with AI provider configured
- Environment variable set (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`)

**Usage:**
```bash
./tests/integration/use-case-1-basic-chat.sh
```

**Options:**
- `--timeout SECONDS` - Maximum wait time for response (default: 120)
- `--port PORT` - REST API port (default: 3000)
- `--verbose` - Enable verbose output

### Use Case 2: Task Execution (`use-case-2-task-execution.sh`)

Tests task execution scenario:
- User sends a task request
- Agent parses the task intent
- Agent executes the task (calls tools if needed)
- Results returned through REST Channel

**Test Scenarios:**
1. Math calculation task (156 * 789)
2. Information retrieval task (list programming languages)
3. Context-aware task (use favorite number for calculation)

**Prerequisites:**
- Same as Use Case 1

**Usage:**
```bash
./tests/integration/use-case-2-task-execution.sh
```

**Options:**
- `--timeout SECONDS` - Maximum wait time for response (default: 120)
- `--port PORT` - REST API port (default: 3000)
- `--verbose` - Enable verbose output

### Use Case 3: Multi-turn Conversation (`use-case-3-multi-turn.sh`)

Tests multi-turn conversation with context:
- User sends multiple messages
- Agent maintains context across turns
- Agent can reference previous messages

> Note: This test is planned and will be added in a future update.

## Running Tests

### All Integration Tests

```bash
npm run test:integration
```

### Individual Tests

```bash
# Use Case 1: Basic Chat
./tests/integration/use-case-1-basic-chat.sh

# Use Case 2: Task Execution
./tests/integration/use-case-2-task-execution.sh

# With verbose output
./tests/integration/use-case-2-task-execution.sh --verbose

# With custom port
./tests/integration/use-case-2-task-execution.sh --port 3001
```

## Test Configuration

### Environment Variables

The tests require AI provider credentials:

```bash
# For Anthropic Claude
export ANTHROPIC_API_KEY=your-api-key

# For OpenAI
export OPENAI_API_KEY=your-api-key
```

### Configuration File

The tests use the main `disclaude.config.yaml` file. Ensure it's properly configured:

```yaml
agent:
  provider: anthropic  # or openai
  model: claude-3-5-sonnet-20241022  # or gpt-4

mcpServers:
  # Configure any required MCP servers
```

## CI/CD Integration

These tests are designed to run in CI/CD pipelines. They:
- Start their own server instance
- Clean up resources on exit
- Return appropriate exit codes

## Test Design Principles

1. **No vitest dependency**: Tests use standalone shell scripts
2. **Self-contained**: Each test handles its own server lifecycle
3. **Configurable**: Support timeout, port, and verbose options
4. **CI-friendly**: Proper exit codes and cleanup

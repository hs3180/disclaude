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
- Agent executes the task (calls tools)
- Results returned through REST Channel

**Usage:**
```bash
./tests/integration/use-case-2-task-execution.sh
```

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
- `--timeout SECONDS` - Maximum wait time for response (default: 120)
- `--port PORT` - REST API port (default: 3000)
- `--verbose` - Enable verbose output

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

# Use Case 3: Multi-turn Conversation
./tests/integration/use-case-3-multi-turn.sh

# With verbose output
./tests/integration/use-case-3-multi-turn.sh --verbose

# With custom port
./tests/integration/use-case-3-multi-turn.sh --port 3001
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
- Support timeout configuration

Example GitHub Actions workflow:

```yaml
- name: Run Integration Tests
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: npm run test:integration
```

## Troubleshooting

### Server Fails to Start

1. Check if the port is already in use: `lsof -i :3000`
2. Check the configuration file is valid
3. Run with `--verbose` to see server logs

### Test Times Out

1. Increase timeout: `--timeout 180`
2. Check API key is valid
3. Check network connectivity to AI provider

### No Response from Agent

1. Verify API key is set correctly
2. Check the model name in configuration
3. Run with `--verbose` to see detailed logs

### Context Not Preserved

1. Ensure the same `chatId` is used across turns
2. Check server logs for any errors
3. Verify the model supports context window

#!/bin/bash
#
# Integration Test Script for REST + Primary + Worker Nodes
#
# Usage: ./scripts/integration-test.sh "your prompt here"
#
# This script:
# 1. Builds the project
# 2. Starts Primary Node (background)
# 3. Starts Worker Node (background)
# 4. Sends a message via REST API
# 5. Waits for response
# 6. Cleans up processes
#

set -e

# Configuration
REST_PORT=3099
WS_PORT=3100
HOST="127.0.0.1"
COMM_URL="ws://${HOST}:${WS_PORT}"
API_URL="http://${HOST}:${REST_PORT}"
TIMEOUT=240

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Process IDs
PRIMARY_PID=""
WORKER_PID=""

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}Cleaning up...${NC}"

    if [ -n "$PRIMARY_PID" ] && kill -0 "$PRIMARY_PID" 2>/dev/null; then
        kill "$PRIMARY_PID" 2>/dev/null || true
        wait "$PRIMARY_PID" 2>/dev/null || true
        echo "Primary Node stopped"
    fi

    if [ -n "$WORKER_PID" ] && kill -0 "$WORKER_PID" 2>/dev/null; then
        kill "$WORKER_PID" 2>/dev/null || true
        wait "$WORKER_PID" 2>/dev/null || true
        echo "Worker Node stopped"
    fi
}

# Register cleanup on exit
trap cleanup EXIT

# Check for prompt argument
if [ -z "$1" ]; then
    echo -e "${RED}Error: No prompt provided${NC}"
    echo "Usage: $0 \"your prompt here\""
    exit 1
fi

PROMPT="$1"

# Copy config file to working directory (uses GLM API from config)
CONFIG_SOURCE="/app/disclaude.config.yaml"
CONFIG_TARGET="./disclaude.config.yaml"
if [ -f "$CONFIG_SOURCE" ]; then
    cp "$CONFIG_SOURCE" "$CONFIG_TARGET"
    echo -e "${GREEN}Copied config from $CONFIG_SOURCE${NC}"
elif [ -f "$CONFIG_TARGET" ]; then
    echo -e "${GREEN}Using existing config: $CONFIG_TARGET${NC}"
else
    echo -e "${RED}Error: Config file not found (tried $CONFIG_SOURCE and $CONFIG_TARGET)${NC}"
    exit 1
fi

# Check for claude CLI (required by Claude Agent SDK)
# If not found, create a temporary wrapper using npx
CLAUDE_WRAPPER_DIR="/tmp/claude-wrapper-$$"
if ! command -v claude &> /dev/null; then
    echo -e "${YELLOW}'claude' CLI not found, creating npx wrapper...${NC}"
    mkdir -p "$CLAUDE_WRAPPER_DIR"
    cat > "$CLAUDE_WRAPPER_DIR/claude" << 'WRAPPER'
#!/bin/bash
npx @anthropic-ai/claude-code "$@"
WRAPPER
    chmod +x "$CLAUDE_WRAPPER_DIR/claude"
    export PATH="$CLAUDE_WRAPPER_DIR:$PATH"
    echo -e "${GREEN}Created claude wrapper using npx${NC}"
fi

echo -e "${GREEN}=== Integration Test ===${NC}"
echo "Prompt: $PROMPT"
echo ""

# Build project
echo -e "${YELLOW}Building project...${NC}"
npm run build --silent
echo -e "${GREEN}Build complete${NC}"
echo ""

# Start Primary Node
# Note: Output goes to stdout for CI visibility (Issue #464)
echo -e "${YELLOW}Starting Primary Node...${NC}"
env PATH="$PATH" NODE_ENV=test node dist/cli-entry.js start --mode primary \
    --port "$WS_PORT" \
    --rest-port "$REST_PORT" \
    --host "$HOST" &
PRIMARY_PID=$!

# Wait for Primary Node to be ready
echo "Waiting for Primary Node..."
for i in $(seq 1 30); do
    if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}Primary Node ready${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}Primary Node failed to start${NC}"
        echo "Check stdout above for logs"
        exit 1
    fi
    sleep 0.5
done

# Start Worker Node
# Unset CLAUDECODE to allow SDK to run (prevents nested session detection)
# Note: Output goes to stdout for CI visibility (Issue #464)
echo -e "${YELLOW}Starting Worker Node...${NC}"
env -u CLAUDECODE PATH="$PATH" NODE_ENV=test DEBUG_CLAUDE_AGENT_SDK=1 node dist/cli-entry.js start --mode worker \
    --comm-url "$COMM_URL" &
WORKER_PID=$!

# Wait for Worker Node to connect
echo "Waiting for Worker Node to connect..."
sleep 2

# Check if processes are still running
if ! kill -0 "$PRIMARY_PID" 2>/dev/null; then
    echo -e "${RED}Primary Node crashed${NC}"
    echo "Check stdout above for logs"
    exit 1
fi

if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    echo -e "${RED}Worker Node crashed${NC}"
    echo "Check stdout above for logs"
    exit 1
fi

echo -e "${GREEN}Both nodes running${NC}"
echo ""

# Send message via REST API
echo -e "${YELLOW}Sending message via REST API...${NC}"
echo "POST ${API_URL}/api/chat/sync"
echo ""

RESPONSE=$(curl -s -X POST "${API_URL}/api/chat/sync" \
    -H "Content-Type: application/json" \
    -d "{\"message\":\"$PROMPT\"}" \
    --max-time "$TIMEOUT")

CURL_EXIT=$?

if [ $CURL_EXIT -ne 0 ]; then
    echo -e "${RED}Request failed (curl exit code: $CURL_EXIT)${NC}"
    echo ""
    echo "Check stdout above for node logs"
    exit 1
fi

echo -e "${GREEN}Response received:${NC}"
echo "$RESPONSE"
echo ""

# Check response success (simple grep-based check)
if echo "$RESPONSE" | grep -q '"success":true'; then
    echo -e "${GREEN}✓ Test passed${NC}"
else
    echo -e "${RED}✗ Test failed${NC}"
    exit 1
fi

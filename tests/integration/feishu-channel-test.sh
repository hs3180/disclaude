#!/bin/bash
#
# Feishu Channel Integration Test Script
#
# Tests Feishu/Lark messaging platform integration.
# Requires Feishu sandbox environment with valid credentials.
#
# Usage:
#   ./tests/integration/feishu-channel-test.sh [options]
#
# Options:
#   --config <file>     Test configuration file (default: tests/integration/feishu-test-config.yaml)
#   --timeout <sec>     Test timeout in seconds (default: 120)
#   --verbose           Enable verbose output
#   --skip-sandbox      Skip sandbox connectivity check
#   --dry-run           Show test plan without executing
#
# Prerequisites:
#   - Feishu App ID and Secret configured
#   - Network access to Feishu API (open.feishu.cn)
#   - Valid test user in Feishu sandbox
#
# Environment Variables:
#   FEISHU_APP_ID       Feishu application ID
#   FEISHU_APP_SECRET   Feishu application secret
#   FEISHU_TEST_CHAT_ID Test chat ID (optional, will create if not provided)
#   FEISHU_TEST_USER_ID Test user open_id (optional)
#

set -e

# Default configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_FILE="${PROJECT_ROOT}/tests/integration/feishu-test-config.yaml"
TIMEOUT=120
VERBOSE=false
SKIP_SANDBOX=false
DRY_RUN=false

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --config)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --skip-sandbox)
            SKIP_SANDBOX=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            sed -n '2,25p' "$0" | sed 's/^#//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[PASS]${NC} $1"
    ((TESTS_PASSED++))
}

log_failure() {
    echo -e "${RED}[FAIL]${NC} $1"
    ((TESTS_FAILED++))
}

log_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
    ((TESTS_SKIPPED++))
}

log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "       $1"
    fi
}

# Run a TypeScript test file and check for success
run_tsx_test() {
    local test_file="$1"
    local expected="$2"  # String to check in output for success

    cd "$PROJECT_ROOT"

    local output
    if output=$(npx tsx "$test_file" 2>&1); then
        if echo "$output" | grep -q "$expected"; then
            return 0
        else
            log_verbose "Output: $output"
            return 1
        fi
    else
        log_verbose "Test failed to run: $output"
        return 1
    fi
}

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_failure "Node.js not found"
        return 1
    fi
    log_verbose "Node.js: $(node --version)"

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_failure "npm not found"
        return 1
    fi
    log_verbose "npm: $(npm --version)"

    # Check curl
    if ! command -v curl &> /dev/null; then
        log_failure "curl not found"
        return 1
    fi

    # Check environment variables
    if [ -z "$FEISHU_APP_ID" ] || [ -z "$FEISHU_APP_SECRET" ]; then
        log_failure "FEISHU_APP_ID and FEISHU_APP_SECRET must be set"
        return 1
    fi
    log_verbose "FEISHU_APP_ID: ${FEISHU_APP_ID:0:8}..."

    log_success "Prerequisites check passed"
    return 0
}

# Get Feishu tenant access token
get_tenant_access_token() {
    local response
    response=$(curl -s -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
        -H "Content-Type: application/json" \
        -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET}")

    if echo "$response" | grep -q '"tenant_access_token"'; then
        echo "$response" | grep -o '"tenant_access_token":"[^"]*"' | cut -d'"' -f4
        return 0
    else
        log_verbose "Token response: $response"
        return 1
    fi
}

# Test: API Connectivity
test_api_connectivity() {
    log_info "Test: API Connectivity"

    local token
    if ! token=$(get_tenant_access_token); then
        log_failure "Failed to get tenant access token"
        return 1
    fi

    log_verbose "Got tenant access token: ${token:0:20}..."
    log_success "API connectivity test passed"
    return 0
}

# Test: Get User Info
test_get_user_info() {
    log_info "Test: Get User Info"

    local token
    if ! token=$(get_tenant_access_token); then
        log_failure "Failed to get tenant access token"
        return 1
    fi

    # If test user ID is provided, get that user's info
    if [ -n "$FEISHU_TEST_USER_ID" ]; then
        local response
        response=$(curl -s -X GET "https://open.feishu.cn/open-apis/contact/v3/users/$FEISHU_TEST_USER_ID" \
            -H "Authorization: Bearer $token")

        if echo "$response" | grep -q '"code":0'; then
            log_verbose "User info retrieved for $FEISHU_TEST_USER_ID"
            log_success "Get user info test passed"
            return 0
        else
            log_verbose "Response: $response"
            log_failure "Failed to get user info"
            return 1
        fi
    else
        log_skip "Get user info test (no FEISHU_TEST_USER_ID provided)"
        return 0
    fi
}

# Test: Send Text Message
test_send_text_message() {
    log_info "Test: Send Text Message"

    if [ -z "$FEISHU_TEST_CHAT_ID" ]; then
        log_skip "Send text message test (no FEISHU_TEST_CHAT_ID provided)"
        return 0
    fi

    local token
    if ! token=$(get_tenant_access_token); then
        log_failure "Failed to get tenant access token"
        return 1
    fi

    local timestamp
    timestamp=$(date -Iseconds)
    local message="{\"msg_type\":\"text\",\"content\":{\"text\":\"[Test] Automated integration test - $timestamp\"}}"

    local response
    response=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "{\"receive_id\":\"$FEISHU_TEST_CHAT_ID\",\"content\":\"$message\"}")

    if echo "$response" | grep -q '"code":0'; then
        local message_id
        message_id=$(echo "$response" | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4)
        log_verbose "Message sent, ID: $message_id"
        log_success "Send text message test passed"
        return 0
    else
        log_verbose "Response: $response"
        log_failure "Failed to send text message"
        return 1
    fi
}

# Test: Send Card Message
test_send_card_message() {
    log_info "Test: Send Card Message"

    if [ -z "$FEISHU_TEST_CHAT_ID" ]; then
        log_skip "Send card message test (no FEISHU_TEST_CHAT_ID provided)"
        return 0
    fi

    local token
    if ! token=$(get_tenant_access_token); then
        log_failure "Failed to get tenant access token"
        return 1
    fi

    local timestamp
    timestamp=$(date -Iseconds)
    local card='{"msg_type":"interactive","content":{"config":{"wide_screen_mode":true},"header":{"title":{"tag":"plain_text","content":"Integration Test Card"},"template":"blue"},"elements":[{"tag":"markdown","content":"Automated test card.\\n\\nTimestamp: '"$timestamp"'"}]}}'

    local response
    response=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "{\"receive_id\":\"$FEISHU_TEST_CHAT_ID\",\"content\":\"$card\"}")

    if echo "$response" | grep -q '"code":0'; then
        local message_id
        message_id=$(echo "$response" | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4)
        log_verbose "Card message sent, ID: $message_id"
        log_success "Send card message test passed"
        return 0
    else
        log_verbose "Response: $response"
        log_failure "Failed to send card message"
        return 1
    fi
}

# Test: Message Recall
test_message_recall() {
    log_info "Test: Message Recall"

    if [ -z "$FEISHU_TEST_CHAT_ID" ]; then
        log_skip "Message recall test (no FEISHU_TEST_CHAT_ID provided)"
        return 0
    fi

    local token
    if ! token=$(get_tenant_access_token); then
        log_failure "Failed to get tenant access token"
        return 1
    fi

    # First, send a message
    local message='{"msg_type":"text","content":{"text":"[Test] Message to be recalled"}}'
    local send_response
    send_response=$(curl -s -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
        -H "Authorization: Bearer $token" \
        -H "Content-Type: application/json" \
        -d "{\"receive_id\":\"$FEISHU_TEST_CHAT_ID\",\"content\":\"$message\"}")

    if ! echo "$send_response" | grep -q '"code":0'; then
        log_failure "Failed to send message for recall test"
        return 1
    fi

    local message_id
    message_id=$(echo "$send_response" | grep -o '"message_id":"[^"]*"' | cut -d'"' -f4)
    log_verbose "Message sent for recall test, ID: $message_id"

    # Wait a moment
    sleep 1

    # Now recall the message
    local recall_response
    recall_response=$(curl -s -X DELETE "https://open.feishu.cn/open-apis/im/v1/messages/$message_id" \
        -H "Authorization: Bearer $token")

    if echo "$recall_response" | grep -q '"code":0'; then
        log_verbose "Message recalled successfully"
        log_success "Message recall test passed"
        return 0
    else
        log_verbose "Recall response: $recall_response"
        log_failure "Failed to recall message"
        return 1
    fi
}

# Test: FeishuChannel Module Import
test_channel_module() {
    log_info "Test: FeishuChannel Module Import"

    local test_file="$PROJECT_ROOT/.test-module-$$.mts"
    cat > "$test_file" << EOF
import { FeishuChannel } from './src/channels/feishu-channel.ts';
const channel = new FeishuChannel({
    appId: '$FEISHU_APP_ID',
    appSecret: '$FEISHU_APP_SECRET'
});
console.log('Channel created:', channel.id);
console.log('TEST_PASSED');
process.exit(0);
process.exit(0);
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "FeishuChannel module import test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "FeishuChannel module import test failed"
        return 1
    fi
}

# Test: Channel Lifecycle
test_channel_lifecycle() {
    log_info "Test: Channel Lifecycle"

    local test_file="$PROJECT_ROOT/.test-lifecycle-$$.mts"
    cat > "$test_file" << EOF
import { FeishuChannel } from './src/channels/feishu-channel.ts';

async function test() {
    const channel = new FeishuChannel({
        appId: '$FEISHU_APP_ID',
        appSecret: '$FEISHU_APP_SECRET'
    });

    // Verify initial state
    if (channel.status !== 'stopped') {
        throw new Error('Initial status should be stopped, got: ' + channel.status);
    }

    // Verify channel properties
    if (!channel.id) {
        throw new Error('Channel ID should be set');
    }

    console.log('Channel ID:', channel.id);
    console.log('Channel name:', channel.name);
    console.log('Channel status:', channel.status);
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "Channel lifecycle test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "Channel lifecycle test failed"
        return 1
    fi
}

# Test: Message Handler Registration
test_message_handler() {
    log_info "Test: Message Handler Registration"

    local test_file="$PROJECT_ROOT/.test-handler-$$.mts"
    cat > "$test_file" << EOF
import { FeishuChannel } from './src/channels/feishu-channel.ts';

async function test() {
    const channel = new FeishuChannel({
        appId: '$FEISHU_APP_ID',
        appSecret: '$FEISHU_APP_SECRET'
    });

    // Register message handler
    channel.onMessage(async (message) => {
        console.log('Handler received:', message.chatId);
    });

    // Verify handler is registered
    if (!channel.messageHandler) {
        throw new Error('Message handler should be registered');
    }

    console.log('Message handler registered successfully');
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "Message handler registration test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "Message handler registration test failed"
        return 1
    fi
}

# Test: Control Handler Registration
test_control_handler() {
    log_info "Test: Control Handler Registration"

    local test_file="$PROJECT_ROOT/.test-control-$$.mts"
    cat > "$test_file" << EOF
import { FeishuChannel } from './src/channels/feishu-channel.ts';

async function test() {
    const channel = new FeishuChannel({
        appId: '$FEISHU_APP_ID',
        appSecret: '$FEISHU_APP_SECRET'
    });

    // Register control handler
    channel.onControl(async (command) => {
        console.log('Control command:', command.type);
        return { success: true };
    });

    // Verify handler is registered
    if (!channel.controlHandler) {
        throw new Error('Control handler should be registered');
    }

    console.log('Control handler registered successfully');
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "Control handler registration test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "Control handler registration test failed"
        return 1
    fi
}

# Test: Interaction Manager
test_interaction_manager() {
    log_info "Test: Interaction Manager"

    local test_file="$PROJECT_ROOT/.test-interaction-$$.mts"
    cat > "$test_file" << EOF
import { FeishuChannel } from './src/channels/feishu-channel.ts';

async function test() {
    const channel = new FeishuChannel({
        appId: '$FEISHU_APP_ID',
        appSecret: '$FEISHU_APP_SECRET'
    });

    // Get interaction manager
    const manager = channel.getInteractionManager();

    if (!manager) {
        throw new Error('InteractionManager should be available');
    }

    // Test dispose
    manager.dispose();

    console.log('InteractionManager test passed');
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "Interaction manager test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "Interaction manager test failed"
        return 1
    fi
}

# Test: FeishuMessageSender
test_message_sender() {
    log_info "Test: FeishuMessageSender Module"

    local test_file="$PROJECT_ROOT/.test-sender-$$.mts"
    cat > "$test_file" << EOF
import { FeishuMessageSender } from './src/platforms/feishu/feishu-message-sender.ts';
import lark from '@larksuiteoapi/node-sdk';

async function test() {
    const client = new lark.Client({
        appId: '$FEISHU_APP_ID',
        appSecret: '$FEISHU_APP_SECRET',
    });

    const sender = new FeishuMessageSender({
        client,
        logger: {
            info: () => {},
            debug: () => {},
            error: () => {},
            warn: () => {},
        }
    });

    console.log('FeishuMessageSender created successfully');
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "FeishuMessageSender test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "FeishuMessageSender test failed"
        return 1
    fi
}

# Test: FeishuAdapter
test_feishu_adapter() {
    log_info "Test: FeishuPlatformAdapter Module"

    local test_file="$PROJECT_ROOT/.test-adapter-$$.mts"
    cat > "$test_file" << EOF
import { FeishuPlatformAdapter } from './src/platforms/feishu/feishu-adapter.ts';

async function test() {
    // Check that the adapter class exists and has expected properties
    const adapter = FeishuPlatformAdapter;

    // Verify class has expected prototype methods
    const prototype = adapter.prototype;
    const methods = ['getClient', 'updateClient'];
    for (const method of methods) {
        if (typeof prototype[method] !== 'function') {
            throw new Error('Method ' + method + ' should exist');
        }
    }

    console.log('FeishuPlatformAdapter methods verified');
    console.log('TEST_PASSED');
process.exit(0);
}

test().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
EOF

    if run_tsx_test "$test_file" "TEST_PASSED"; then
        rm -f "$test_file"
        log_success "FeishuAdapter test passed"
        return 0
    else
        rm -f "$test_file"
        log_failure "FeishuAdapter test failed"
        return 1
    fi
}

# Print test summary
print_summary() {
    echo ""
    echo "================================"
    echo "       Test Summary"
    echo "================================"
    echo -e "Passed:  ${GREEN}$TESTS_PASSED${NC}"
    echo -e "Failed:  ${RED}$TESTS_FAILED${NC}"
    echo -e "Skipped: ${YELLOW}$TESTS_SKIPPED${NC}"
    echo "================================"

    if [ "$TESTS_FAILED" -gt 0 ]; then
        return 1
    fi
    return 0
}

# Cleanup function
cleanup() {
    rm -f "$PROJECT_ROOT"/.test-*.mts 2>/dev/null || true
}

# Main test runner
main() {
    # Register cleanup on exit
    trap cleanup EXIT

    echo ""
    echo "================================"
    echo " Feishu Channel Integration Test"
    echo "================================"
    echo ""
    echo "Configuration:"
    echo "  Config file: $CONFIG_FILE"
    echo "  Timeout: ${TIMEOUT}s"
    echo "  Verbose: $VERBOSE"
    echo "  Dry run: $DRY_RUN"
    echo ""

    if [ "$DRY_RUN" = true ]; then
        log_info "Dry run mode - showing test plan only"
        echo ""
        echo "Tests to be executed:"
        echo "  1. Prerequisites check"
        echo "  2. FeishuChannel module import test"
        echo "  3. Channel lifecycle test"
        echo "  4. Message handler registration test"
        echo "  5. Control handler registration test"
        echo "  6. Interaction manager test"
        echo "  7. FeishuMessageSender test"
        echo "  8. FeishuAdapter test"
        echo "  9. API connectivity test (optional)"
        echo "  10. Get user info test (optional)"
        echo "  11. Send text message test (optional)"
        echo "  12. Send card message test (optional)"
        echo "  13. Message recall test (optional)"
        exit 0
    fi

    # Run tests
    check_prerequisites || true

    # Module tests (no network required)
    test_channel_module || true
    test_channel_lifecycle || true
    test_message_handler || true
    test_control_handler || true
    test_interaction_manager || true
    test_message_sender || true
    test_feishu_adapter || true

    # API tests (require network and credentials)
    if [ "$SKIP_SANDBOX" = false ]; then
        test_api_connectivity || true
        test_get_user_info || true
        test_send_text_message || true
        test_send_card_message || true
        test_message_recall || true
    else
        log_skip "API tests (--skip-sandbox specified)"
    fi

    # Print summary
    print_summary
}

# Run main
main

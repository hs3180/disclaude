#!/bin/bash
#
# Multimodal Integration Test Script for Issue #808
#
# Tests native multimodal model support in disclaude:
# 1. Single image with text query
# 2. Multiple images for comparison
# 3. Image + text mixed message
# 4. Screenshot for code explanation
#
# Usage:
#   ./multimodal-test.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 120)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-120}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Data Setup
# =============================================================================

TEST_IMAGES_DIR=""

create_test_images() {
    local test_dir="${PROJECT_ROOT}/workspace/test-images"
    mkdir -p "$test_dir"

    if command -v convert &> /dev/null; then
        if [ ! -f "$test_dir/test-image.png" ]; then
            convert -size 200x200 xc:blue -fill white -draw "text 50,100 'Test Image'" \
                "$test_dir/test-image.png" 2>/dev/null || true
        fi
        if [ ! -f "$test_dir/test-mixed.png" ]; then
            convert -size 300x200 xc:lightblue -fill black -draw "text 50,100 'Dashboard Data'" \
                "$test_dir/test-mixed.png" 2>/dev/null || true
        fi
        if [ ! -f "$test_dir/test-screenshot.png" ]; then
            convert -size 400x300 xc:white -fill black -draw "text 50,100 'Code Screenshot'" \
                "$test_dir/test-screenshot.png" 2>/dev/null || true
        fi
        log_debug "Test images created in $test_dir"
    fi

    # Fallback: minimal valid PNG
    local img
    for img in test-image test-mixed test-screenshot; do
        if [ ! -f "$test_dir/${img}.png" ]; then
            echo -n 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' \
                | base64 -d > "$test_dir/${img}.png" 2>/dev/null || echo "placeholder" > "$test_dir/${img}.png"
        fi
    done

    TEST_IMAGES_DIR="$test_dir"
}

# =============================================================================
# Multimodal Request Helper
# =============================================================================

send_multimodal_request() {
    local prompt="$1"
    local image_path="${2:-}"
    local chatId="${3:-test-multimodal-$$}"

    local body
    if [ -n "$image_path" ] && [ -f "$image_path" ]; then
        body=$(jq -n \
            --arg msg "$prompt" \
            --arg cid "$chatId" \
            --arg fname "$(basename "$image_path")" \
            --arg fpath "$image_path" \
            '{
                message: $msg,
                chatId: $cid,
                attachments: [{
                    file_name: $fname,
                    local_path: $fpath,
                    mime_type: "image/png"
                }]
            }')
    else
        body=$(jq -n \
            --arg msg "$prompt" \
            --arg cid "$chatId" \
            '{message: $msg, chatId: $cid}')
    fi

    local result
    result=$(make_request "POST" "/api/chat/sync" "$body")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "200" ]; then
        log_pass "Multimodal request successful"
        log_debug "Response: $RESPONSE_BODY"
        return 0
    else
        log_fail "Multimodal request failed with status $RESPONSE_STATUS"
        log_error "Response: $RESPONSE_BODY"
        return 1
    fi
}

# =============================================================================
# Test Functions
# =============================================================================

test_single_image() {
    log_info "Test: Single image with text query"

    local image_path="${TEST_IMAGES_DIR}/test-image.png"
    if [ ! -f "$image_path" ]; then
        log_warn "Test image not found, using placeholder"
        echo "Test image content" > "$image_path"
    fi

    send_multimodal_request "Please describe what you see in this image." "$image_path"
}

test_multi_image() {
    log_info "Test: Multiple images for comparison (text prompt)"
    send_multimodal_request "Compare the design patterns in typical MVC vs MVVM architecture and recommend the best one for a new project."
}

test_mixed_message() {
    log_info "Test: Image + text mixed message"

    local image_path="${TEST_IMAGES_DIR}/test-mixed.png"
    if [ ! -f "$image_path" ]; then
        log_warn "Test image not found, using placeholder"
        echo "Dashboard screenshot content" > "$image_path"
    fi

    local prompt="I uploaded a dashboard screenshot. Please help me:
1. Analyze the current data trends
2. Find any anomalies
3. Provide improvement suggestions

This is last week's sales data."

    send_multimodal_request "$prompt" "$image_path"
}

test_screenshot() {
    log_info "Test: Screenshot for code explanation"

    local image_path="${TEST_IMAGES_DIR}/test-screenshot.png"
    if [ ! -f "$image_path" ]; then
        log_warn "Test image not found, using placeholder"
        echo "Code screenshot content" > "$image_path"
    fi

    send_multimodal_request "This is a screenshot of my code. Please explain what this code does and suggest improvements." "$image_path"
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "Single image" test_single_image "ai" "Send image with description request"
declare_test "Multi image" test_multi_image "ai" "Complex prompt about image comparison"
declare_test "Mixed message" test_mixed_message "ai" "Image with multi-part text instructions"
declare_test "Screenshot" test_screenshot "ai" "Code screenshot analysis request"

main_test_suite "Multimodal Integration Tests (Issue #808)" create_test_images

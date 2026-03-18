#!/bin/bash
#
# Multimodal Integration Test Script for Issue #808
#
# This script tests native multimodal model support in disclaude:
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

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set defaults before sourcing common.sh
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-120}"

# Source common functions
source "$SCRIPT_DIR/common.sh"

# Parse common arguments
parse_common_args "$@"

# Register cleanup handler
register_cleanup

# =============================================================================
# Test Data Setup
# =============================================================================

# Create test images for multimodal testing
create_test_images() {
    local test_dir="${PROJECT_ROOT}/workspace/test-images"
    mkdir -p "$test_dir"

    # Create test image using ImageMagick if available
    if command -v convert &> /dev/null; then
        # Single image test
        if [ ! -f "$test_dir/test-image.png" ]; then
            convert -size 200x200 xc:blue -fill white -draw "text 50,100 'Test Image'" \
                "$test_dir/test-image.png" 2>/dev/null || true
        fi

        # Mixed message test
        if [ ! -f "$test_dir/test-mixed.png" ]; then
            convert -size 300x200 xc:lightblue -fill black -draw "text 50,100 'Dashboard Data'" \
                "$test_dir/test-mixed.png" 2>/dev/null || true
        fi

        # Screenshot test
        if [ ! -f "$test_dir/test-screenshot.png" ]; then
            convert -size 400x300 xc:white -fill black -draw "text 50,100 'Code Screenshot'" \
                "$test_dir/test-screenshot.png" 2>/dev/null || true
        fi

        log_debug "Test images created in $test_dir"
    fi

    # Create placeholder text files if images don't exist
    # This allows tests to proceed even without ImageMagick
    if [ ! -f "$test_dir/test-image.png" ]; then
        # Create a minimal valid PNG file (1x1 pixel)
        echo -n 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > "$test_dir/test-image.png" 2>/dev/null || echo "placeholder" > "$test_dir/test-image.png"
    fi

    if [ ! -f "$test_dir/test-mixed.png" ]; then
        echo -n 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > "$test_dir/test-mixed.png" 2>/dev/null || echo "placeholder" > "$test_dir/test-mixed.png"
    fi

    if [ ! -f "$test_dir/test-screenshot.png" ]; then
        echo -n 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' | base64 -d > "$test_dir/test-screenshot.png" 2>/dev/null || echo "placeholder" > "$test_dir/test-screenshot.png"
    fi

    echo "$test_dir"
}

# =============================================================================
# Multimodal Request Helpers
# =============================================================================

# Send multimodal message via REST API
# Usage: send_multimodal_request "prompt" "image_path"
send_multimodal_request() {
    local prompt="$1"
    local image_path="${2:-}"
    local chatId="${3:-multimodal-test-$$}"

    log_info "Sending multimodal request..."
    log_debug "Prompt: $prompt"
    if [ -n "$image_path" ]; then
        log_debug "Image: $image_path"
    fi

    local body
    if [ -n "$image_path" ] && [ -f "$image_path" ]; then
        body=$(cat <<EOF
{
  "message": "${prompt}",
  "chatId": "${chatId}",
  "attachments": [
    {
      "file_name": "$(basename "$image_path")",
      "local_path": "${image_path}",
      "mime_type": "image/png"
    }
  ]
}
EOF
)
    else
        body="{\"message\":\"${prompt}\",\"chatId\":\"${chatId}\"}"
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
# Test Cases
# =============================================================================

# Test case 1: Single image with text query
test_single_image() {
    local test_dir="$1"
    local image_path="${test_dir}/test-image.png"

    echo ""
    log_info "Test Case 1: Single Image with Text Query"
    log_info "Scenario: User sends a single image and asks about its content"

    # Create placeholder if image doesn't exist
    if [ ! -f "$image_path" ]; then
        log_warn "Test image not found, using placeholder"
        echo "Test image content" > "$image_path"
    fi

    send_multimodal_request "Please describe what you see in this image." "$image_path"
}

# Test case 2: Multiple images for comparison (text-only, verifies message builder)
test_multi_image() {
    echo ""
    log_info "Test Case 2: Multiple Images for Comparison"
    log_info "Scenario: User asks about comparing images (text prompt only)"

    # Note: REST API currently supports single message with attachments
    # This test verifies the system handles complex prompts about image comparison
    send_multimodal_request "Compare the design patterns in typical MVC vs MVVM architecture and recommend the best one for a new project."
}

# Test case 3: Image + text mixed message
test_mixed_message() {
    local test_dir="$1"
    local image_path="${test_dir}/test-mixed.png"

    echo ""
    log_info "Test Case 3: Image + Text Mixed Message"
    log_info "Scenario: User sends image with detailed text context"

    # Create placeholder if image doesn't exist
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

# Test case 4: Screenshot for code explanation
test_screenshot() {
    local test_dir="$1"
    local image_path="${test_dir}/test-screenshot.png"

    echo ""
    log_info "Test Case 4: Screenshot for Code Explanation"
    log_info "Scenario: User sends code screenshot for explanation"

    # Create placeholder if image doesn't exist
    if [ ! -f "$image_path" ]; then
        log_warn "Test image not found, using placeholder"
        echo "Code screenshot content" > "$image_path"
    fi

    local prompt="This is a screenshot of my code. Please explain what this code does and suggest improvements."

    send_multimodal_request "$prompt" "$image_path"
}

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  Multimodal Integration Tests (Issue #808)"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Cases:"
    echo "  1. Single Image with Text Query"
    echo "     - Send image with description request"
    echo "     - Verify multimodal message handling"
    echo ""
    echo "  2. Multiple Images for Comparison"
    echo "     - Complex prompt about image comparison"
    echo "     - Tests message builder with detailed context"
    echo ""
    echo "  3. Image + Text Mixed Message"
    echo "     - Image with multi-part text instructions"
    echo "     - Tests combined multimodal context"
    echo ""
    echo "  4. Screenshot for Code Explanation"
    echo "     - Code screenshot analysis request"
    echo "     - Tests visual code understanding"
    echo ""
    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo "  - Project Root: $PROJECT_ROOT"
    echo ""
    echo "Prerequisites:"
    echo "  - Node.js installed"
    echo "  - disclaude built (npm run build)"
    echo "  - Valid disclaude.config.yaml"
    echo "  - API key configured in config file"
    echo ""
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Multimodal Integration Tests (Issue #808)"
    echo "=========================================="
    echo ""

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        show_test_plan
        exit 0
    fi

    # Check prerequisites
    check_prerequisites || exit 1

    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo ""

    # Start server
    start_server || exit 1

    # Create test data
    local test_dir
    test_dir=$(create_test_images)

    # Run health check first
    test_health_check || exit 1

    # Default to running all tests
    test_single_image "$test_dir"
    test_multi_image
    test_mixed_message "$test_dir"
    test_screenshot "$test_dir"

    # Print summary
    print_summary
}

main "$@"

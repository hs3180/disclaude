#!/bin/bash
# Compatibility entry point. REST chat is text-only: verify unsupported image
# requests fail explicitly, not HTTP 200 after silently dropping attachments.
# Native image comprehension is not certified by this suite.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

test_attachment_rejection() {
    local route body result
    body='{"message":"Describe this image","attachments":[{"file_name":"image.png","local_path":"/not-read/image.png","mime_type":"image/png"}]}'
    for route in /api/chat /api/chat/sync /api/chat/attachment-rejection; do
        result=$(make_request POST "$route" "$body")
        parse_response "$result"
        assert_status 400 "$route rejects unsupported attachments" || return 1
        assert_body_contains 'REST chat attachments are not supported' "$route gives an actionable error" || return 1
    done
}

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "Attachment rejection" test_attachment_rejection "fast" "Unsupported images never become successful text-only requests"
main_test_suite "REST Attachment Contract Tests"

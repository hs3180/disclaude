#!/bin/bash
#
# Integration E2E: Codex compatibility checks
#
# Exit code 2 from codex-e2e.mts means the host cannot provide a supported
# Codex environment and is reported as SKIP by run-all-tests.sh.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

VERBOSE=false
DRY_RUN=false
while [[ $# -gt 0 ]]; do
    case "$1" in
        --verbose) VERBOSE=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --port|--timeout|--tag|--name) shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--verbose] [--dry-run]"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

if [ "$DRY_RUN" = true ]; then
    echo "Registered tests:"
    echo "  [ai] Codex CLI compatibility (scripts/codex-e2e.mts)"
    echo "Total: 1 test(s)"
    exit 0
fi

echo ""
echo "=========================================="
echo "  Codex CLI Compatibility E2E"
echo "=========================================="

if [ "$VERBOSE" = true ]; then
    echo "[INFO] Running real Codex compatibility checks"
fi

set +e
npx tsx "$PROJECT_ROOT/scripts/codex-e2e.mts"
status=$?
set -e

if [ "$status" -eq 0 ]; then
    echo "[PASS] Codex compatibility E2E"
    exit 0
fi
if [ "$status" -eq 2 ]; then
    echo "[SKIP] Codex compatibility E2E: host environment is unavailable"
    echo "[SKIP] Check codex login, CLI installation, app-server permissions, and network access."
    exit 0
fi

echo "[FAIL] Codex compatibility E2E (exit code $status)"
exit "$status"

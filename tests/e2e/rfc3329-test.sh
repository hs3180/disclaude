#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"

echo "🧪 Running RFC #3329 e2e tests..."
npx vitest --run --config tests/e2e/rfc3329/vitest.config.ts "$@"

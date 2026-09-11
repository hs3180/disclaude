#!/bin/bash
# Run the maintained service integration suite; no separate execution-node process.
set -euo pipefail
exec "$(dirname "$0")/../tests/integration/run-all-tests.sh" "$@"

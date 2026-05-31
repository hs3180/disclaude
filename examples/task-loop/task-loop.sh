#!/usr/bin/env bash
#
# Task While-Loop Template (Bash)
#
# Drives an agent to execute a multi-step task by repeatedly pushing
# system messages via disclaude-push CLI. The agent executes one step
# per iteration, while this script handles loop control.
#
# Related: #3812 — Task While-Loop via script + system message
# Depends: #3808 — disclaude-push CLI
#
# Usage:
#   1. Copy this template and customize variables
#   2. chmod +x task-loop.sh
#   3. ./task-loop.sh
#
# Options:
#   --chat-id   Target chat ID (required)
#   --task-id   Task identifier for file-based state tracking (required)
#   --max-iter  Maximum iterations (default: 10)
#   --interval  Seconds between iterations (default: 30)
#   --done-file Relative path to completion marker file (default: tasks/<task-id>/done)
#   --help      Show usage

set -euo pipefail

# ---- Defaults ----
CHAT_ID=""
TASK_ID=""
MAX_ITER=10
INTERVAL=30
DONE_FILE=""

# ---- Parse Args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat-id)   CHAT_ID="$2"; shift 2 ;;
    --task-id)   TASK_ID="$2"; shift 2 ;;
    --max-iter)  MAX_ITER="$2"; shift 2 ;;
    --interval)  INTERVAL="$2"; shift 2 ;;
    --done-file) DONE_FILE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 --chat-id <id> --task-id <id> [--max-iter N] [--interval S]"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$CHAT_ID" || -z "$TASK_ID" ]]; then
  echo "Error: --chat-id and --task-id are required."
  echo "Run with --help for usage."
  exit 1
fi

# Done file path: tasks/<task-id>/done unless overridden
DONE_FILE="${DONE_FILE:-tasks/${TASK_ID}/done}"

# ---- Functions ----

push_message() {
  local msg="$1"
  echo "[task-loop] Pushing: $msg"
  disclaude-push --chat-id "$CHAT_ID" --message "$msg"
}

check_done() {
  [[ -f "$DONE_FILE" ]]
}

# ---- Main Loop ----

echo "[task-loop] Starting task '$TASK_ID' (max $MAX_ITER iterations, ${INTERVAL}s interval)"

for i in $(seq 1 "$MAX_ITER"); do
  echo "[task-loop] --- Iteration $i/$MAX_ITER ---"

  # Check completion condition
  if check_done; then
    echo "[task-loop] Done file detected: $DONE_FILE"
    push_message "任务 $TASK_ID 已完成（检测到完成标记）。请发送最终总结。"
    exit 0
  fi

  # Push next step instruction
  push_message "继续执行 $TASK_ID 步骤 $i/$MAX_ITER。请检查当前进展并继续执行下一步。"

  # Wait for agent to process (skip wait on last iteration)
  if [[ $i -lt "$MAX_ITER" ]]; then
    echo "[task-loop] Waiting ${INTERVAL}s for agent to process..."
    sleep "$INTERVAL"
  fi
done

# ---- Timeout ----
echo "[task-loop] Reached max iterations ($MAX_ITER)"
push_message "任务 $TASK_ID 已达到最大迭代次数 ($MAX_ITER)。请发送当前进展报告。"
exit 0

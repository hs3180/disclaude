#!/usr/bin/env bash
# Task While Loop — 外部脚本驱动 agent 循环执行任务
#
# 通过 REST /api/push 接口向 agent 推送 system message，
# 驱动 agent 逐步执行复杂任务，直到完成或达到最大迭代次数。
#
# 依赖: disclaude REST channel 的 /api/push 端点 (Issue #3808)
#
# 用法:
#   ./task-while-loop.sh <chat_id> <task_instruction> [max_iterations] [interval_seconds] [done_marker]
#
# 示例:
#   ./task-while-loop.sh oc_xxx "请分析 PR #1234 的代码变更" 10 30
#   ./task-while-loop.sh oc_xxx "重构 src/utils.ts" 5 60 /tmp/task-done

set -euo pipefail

# --- 参数 ---
CHAT_ID="${1:?用法: $0 <chat_id> <task_instruction> [max_iterations] [interval_seconds] [done_marker]}"
TASK_INSTRUCTION="${2:?用法: $0 <chat_id> <task_instruction> [max_iterations] [interval_seconds] [done_marker]}"
MAX_ITERATIONS="${3:-10}"
INTERVAL="${4:-30}"
DONE_MARKER="${5:-}"

REST_HOST="${REST_HOST:-localhost}"
REST_PORT="${REST_PORT:-3099}"
PUSH_URL="http://${REST_HOST}:${REST_PORT}/api/push"

# --- 辅助函数 ---
log() { echo "[$(date '+%H:%M:%S')] $*"; }

push_to_agent() {
  local chat_id="$1"
  local message="$2"
  local response
  response=$(curl -sf -X POST "$PUSH_URL" \
    -H "Content-Type: application/json" \
    -d "{\"chatId\":\"${chat_id}\",\"message\":$(printf '%s' "$message" | jq -Rs .)}" 2>&1) || {
    log "ERROR: push failed: $response"
    return 1
  }
  log "Pushed: ${message:0:80}..."
}

# --- 检查完成条件 ---
check_done() {
  if [ -n "$DONE_MARKER" ] && [ -f "$DONE_MARKER" ]; then
    return 0
  fi
  return 1
}

# --- 主循环 ---
log "Starting task loop: chat=$CHAT_ID max=$MAX_ITERATIONS interval=${INTERVAL}s"
log "Task: $TASK_INSTRUCTION"

# 发送初始任务指令
push_to_agent "$CHAT_ID" "$TASK_INSTRUCTION"

for i in $(seq 2 "$MAX_ITERATIONS"); do
  sleep "$INTERVAL"

  # 检查完成条件
  if check_done; then
    log "Done marker found: $DONE_MARKER"
    push_to_agent "$CHAT_ID" "任务已完成，请发送最终总结。"
    exit 0
  fi

  # 推送继续指令
  push_to_agent "$CHAT_ID" "继续执行任务 — 步骤 ${i}/${MAX_ITERATIONS}。请检查当前进展并继续。"
done

# 超过最大迭代
log "Reached max iterations ($MAX_ITERATIONS)"
push_to_agent "$CHAT_ID" "任务已达到最大迭代次数 (${MAX_ITERATIONS})，请发送当前进展报告。"
exit 1

#!/usr/bin/env bash
# record-audio.sh — TCC-safe audio recording for macOS PM2 environments
#
# When disclaude runs under PM2 on macOS, TCC silently blocks microphone access
# for the entire process chain because the node/PM2 ancestor process lacks
# microphone permission. This script detects the PM2 chain and delegates
# recording to an independent Terminal.app process via osascript.
#
# See: https://github.com/hs3180/disclaude/issues/1957
#
# Environment variables:
#   OUTPUT         (required) Output file path for the recorded audio (.wav)
#   DURATION       (optional) Recording duration in seconds (default: 5)
#   DEVICE         (optional) Audio device index for ffmpeg avfoundation
#   NO_PM2_BYPASS  (optional) If "true", skip PM2 detection and record directly
#
# Exit codes:
#   0 — success
#   1 — validation error or recording failure
#   2 — PM2/TCC detected but cannot bypass (non-macOS)
#   3 — ffmpeg not found

set -euo pipefail

# ---- Configuration ----
DURATION="${DURATION:-5}"
DEVICE="${DEVICE:-}"
NO_PM2_BYPASS="${NO_PM2_BYPASS:-false}"
MAX_DURATION=3600

# ---- Step 1: Validate inputs ----
if [ -z "${OUTPUT:-}" ]; then
  echo "ERROR: OUTPUT environment variable is required" >&2
  exit 1
fi

OUTPUT_DIR=$(dirname "$OUTPUT")
if [ ! -d "$OUTPUT_DIR" ]; then
  echo "ERROR: Output directory '$OUTPUT_DIR' does not exist" >&2
  exit 1
fi

if ! echo "$DURATION" | grep -qE '^[0-9]+$'; then
  echo "ERROR: DURATION must be a positive integer, got '$DURATION'" >&2
  exit 1
fi

if [ "$DURATION" -eq 0 ]; then
  echo "ERROR: DURATION must be > 0" >&2
  exit 1
fi

if [ "$DURATION" -gt "$MAX_DURATION" ]; then
  echo "ERROR: DURATION exceeds maximum (${MAX_DURATION}s)" >&2
  exit 1
fi

# ---- Step 2: Check for ffmpeg ----
if ! command -v ffmpeg &>/dev/null; then
  echo "ERROR: ffmpeg is required but not found in PATH" >&2
  exit 3
fi

# ---- Step 3: Detect PM2 process chain ----
is_under_pm2() {
  # Only relevant on macOS
  [ "$(uname)" != "Darwin" ] && return 1

  _pid=$$
  _depth=0
  _max_depth=15

  while [ "$_pid" -gt 1 ] && [ "$_depth" -lt "$_max_depth" ]; do
    _cmd=$(ps -p "$_pid" -o command= 2>/dev/null || true)

    case "$_cmd" in
      *PM2*|*pm2*god*|*pm2-[a-z]*)
        return 0
        ;;
    esac

    # Get parent PID
    _pid=$(ps -p "$_pid" -o ppid= 2>/dev/null | tr -d ' ' || echo "0")
    _depth=$((_depth + 1))
  done

  return 1
}

# ---- Step 4: Build ffmpeg arguments ----
build_device_arg() {
  if [ -n "$DEVICE" ]; then
    echo ":${DEVICE}"
  else
    echo ":default"
  fi
}

# ---- Step 5: Record audio ----
if [ "$NO_PM2_BYPASS" = "true" ] || ! is_under_pm2; then
  # Direct recording (not under PM2 or bypass disabled)
  _device_arg=$(build_device_arg)

  if [ "$(uname)" = "Darwin" ]; then
    ffmpeg -f avfoundation -i "$_device_arg" -t "$DURATION" -y "$OUTPUT" 2>/dev/null
  elif [ "$(uname)" = "Linux" ]; then
    ffmpeg -f pulse -i "${DEVICE:-default}" -t "$DURATION" -y "$OUTPUT" 2>/dev/null
  else
    ffmpeg -i "${DEVICE:-default}" -t "$DURATION" -y "$OUTPUT" 2>/dev/null
  fi

  echo "OK: Recording saved to $OUTPUT"
else
  # PM2 detected — use osascript to spawn recording in Terminal.app
  if [ "$(uname)" != "Darwin" ]; then
    echo "ERROR: Running under PM2 but not on macOS — cannot bypass TCC" >&2
    exit 2
  fi

  if ! command -v osascript &>/dev/null; then
    echo "ERROR: osascript is required for PM2 bypass but not found" >&2
    exit 2
  fi

  _device_arg=$(build_device_arg)
  _ffmpeg_cmd="ffmpeg -f avfoundation -i ${_device_arg} -t ${DURATION} -y ${OUTPUT}"

  # Spawn in independent Terminal.app process to bypass TCC chain
  osascript -e "tell application \"Terminal\" to do script \"${_ffmpeg_cmd}\"" 2>/dev/null

  # Wait for the file to appear (with timeout)
  _timeout=$((DURATION * 3))
  _elapsed=0
  while [ ! -f "$OUTPUT" ] && [ "$_elapsed" -lt "$_timeout" ]; do
    sleep 1
    _elapsed=$((_elapsed + 1))
  done

  if [ ! -f "$OUTPUT" ]; then
    echo "ERROR: Recording timed out after ${_timeout}s" >&2
    exit 1
  fi

  echo "OK: Recording saved to $OUTPUT (via Terminal.app bypass)"
fi

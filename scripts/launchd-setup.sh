#!/usr/bin/env bash
#
# launchd-setup.sh — Install, manage, and uninstall disclaude as a macOS LaunchAgent
#
# This script automates the setup of disclaude as a launchd service on macOS,
# replacing PM2 to avoid TCC (Transparency, Consent, and Control) permission issues.
#
# Usage:
#   ./scripts/launchd-setup.sh install    # Build, generate plist, and load service
#   ./scripts/launchd-setup.sh uninstall  # Unload and remove plist
#   ./scripts/launchd-setup.sh status     # Check service status
#   ./scripts/launchd-setup.sh logs       # Tail logs (Ctrl+C to exit)
#   ./scripts/launchd-setup.sh restart    # Unload + load (graceful restart)
#
# Prerequisites:
#   - macOS (launchd is macOS-only)
#   - Node.js >= 20 installed and in PATH
#   - disclaude project built (npm run build) or this script will build it
#
# See docs/macos-launchd.md for the full migration guide.

set -euo pipefail

# ============================================================================
# Configuration
# ============================================================================

PLIST_LABEL="com.disclaude"
PLIST_TEMPLATE="$(dirname "$0")/../com.disclaude.plist.example"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${PROJECT_DIR}/logs"
NODE_BIN="$(command -v node 2>/dev/null || echo '/usr/local/bin/node')"
CLI_ENTRY="packages/primary-node/dist/cli.js"

# Colors for output (if terminal supports it)
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  NC=''
fi

# ============================================================================
# Helper Functions
# ============================================================================

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

check_macos() {
  if [ "$(uname)" != "Darwin" ]; then
    error "This script is for macOS only. On Linux, use PM2 (npm run pm2:start)."
    exit 1
  fi
}

check_node() {
  if [ ! -x "$NODE_BIN" ]; then
    error "Node.js not found at ${NODE_BIN}. Install Node.js >= 20 first."
    exit 1
  fi
}

check_built() {
  if [ ! -f "${PROJECT_DIR}/${CLI_ENTRY}" ]; then
    info "Project not built yet. Running npm run build..."
    (cd "$PROJECT_DIR" && npm run build)
    if [ ! -f "${PROJECT_DIR}/${CLI_ENTRY}" ]; then
      error "Build succeeded but ${CLI_ENTRY} not found. Check the build output."
      exit 1
    fi
    ok "Build completed successfully."
  fi
}

# Generate plist from template with actual paths substituted
generate_plist() {
  local template="$1"
  local output="$2"

  if [ ! -f "$template" ]; then
    error "Plist template not found: ${template}"
    exit 1
  fi

  # Create logs directory if needed
  mkdir -p "$LOG_DIR"

  # Read template and substitute placeholder paths
  sed \
    -e "s|/usr/local/bin/node|${NODE_BIN}|g" \
    -e "s|/path/to/disclaude/packages/primary-node/dist/cli.js|${PROJECT_DIR}/${CLI_ENTRY}|g" \
    -e "s|<string>/path/to/disclaude</string>|<string>${PROJECT_DIR}</string>|g" \
    -e "s|/path/to/disclaude/logs/launchd-stdout.log|${LOG_DIR}/launchd-stdout.log|g" \
    -e "s|/path/to/disclaude/logs/launchd-stderr.log|${LOG_DIR}/launchd-stderr.log|g" \
    "$template" > "$output"

  # Verify the generated plist is valid XML
  if ! plutil -lint "$output" >/dev/null 2>&1; then
    error "Generated plist is not valid XML: ${output}"
    rm -f "$output"
    exit 1
  fi
}

is_loaded() {
  launchctl list "$PLIST_LABEL" >/dev/null 2>&1
}

get_pid() {
  local pid
  pid=$(launchctl list "$PLIST_LABEL" 2>/dev/null | grep 'PID' | awk '{print $NF}')
  echo "${pid:-}"
}

# ============================================================================
# Commands
# ============================================================================

cmd_install() {
  check_macos
  check_node
  check_built

  info "Installing disclaude as LaunchAgent..."

  # Generate plist
  generate_plist "$PLIST_TEMPLATE" "$PLIST_DEST"
  ok "Generated plist: ${PLIST_DEST}"

  # Unload if already loaded (for re-install / upgrade)
  if is_loaded; then
    warn "Service is already loaded. Unloading first..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    sleep 1
  fi

  # Load the LaunchAgent
  launchctl load "$PLIST_DEST"
  ok "Loaded LaunchAgent: ${PLIST_LABEL}"

  # Wait briefly and check status
  sleep 2
  if is_loaded; then
    local pid
    pid=$(get_pid)
    if [ -n "$pid" ] && [ "$pid" != "-" ]; then
      ok "Service is running (PID: ${pid})"
    else
      warn "Service is loaded but may still be starting up."
    fi
  else
    error "Service failed to load. Check logs: ${LOG_DIR}/launchd-stderr.log"
    exit 1
  fi

  echo ""
  info "Setup complete!"
  info "  Config file: ${PROJECT_DIR}/disclaude.config.yaml"
  info "  Stdout log:  ${LOG_DIR}/launchd-stdout.log"
  info "  Stderr log:  ${LOG_DIR}/launchd-stderr.log"
  info ""
  info "  Manage: ./scripts/launchd-setup.sh {status|logs|restart|uninstall}"
  info ""
  warn "IMPORTANT: On first launch, macOS may prompt for TCC permissions (microphone, etc.)."
  warn "           Grant permissions to 'node' or 'Terminal' when prompted."
}

cmd_uninstall() {
  check_macos

  info "Uninstalling disclaude LaunchAgent..."

  if is_loaded; then
    launchctl unload "$PLIST_DEST"
    ok "Unloaded service."
  else
    warn "Service is not loaded."
  fi

  if [ -f "$PLIST_DEST" ]; then
    rm -f "$PLIST_DEST"
    ok "Removed plist: ${PLIST_DEST}"
  else
    warn "Plist not found: ${PLIST_DEST}"
  fi

  ok "Uninstall complete."
}

cmd_status() {
  check_macos

  if [ ! -f "$PLIST_DEST" ]; then
    warn "LaunchAgent plist not installed."
    info "  Run './scripts/launchd-setup.sh install' to set up."
    exit 0
  fi

  if is_loaded; then
    local pid exit_status
    pid=$(get_pid)
    exit_status=$(launchctl list "$PLIST_LABEL" 2>/dev/null | grep 'LastExitStatus' | awk '{print $NF}')
    ok "Service: loaded"
    if [ -n "$pid" ] && [ "$pid" != "-" ]; then
      ok "PID: ${pid}"
    else
      if [ "${exit_status:-0}" != "0" ]; then
        error "Process exited with status: ${exit_status}"
        warn "  Check stderr log: ${LOG_DIR}/launchd-stderr.log"
      else
        info "PID: (starting...)"
      fi
    fi
  else
    warn "Service: not loaded (plist exists)"
    info "  Run './scripts/launchd-setup.sh install' or 'launchctl load ${PLIST_DEST}'."
  fi
}

cmd_logs() {
  check_macos

  local log_file="${LOG_DIR}/launchd-stdout.log"
  local err_file="${LOG_DIR}/launchd-stderr.log"

  if [ ! -f "$log_file" ] && [ ! -f "$err_file" ]; then
    warn "No log files found yet."
    exit 0
  fi

  info "Tailing logs (Ctrl+C to exit)..."
  echo ""

  # Tail both stdout and stderr logs if they exist
  local files=()
  [ -f "$log_file" ] && files+=("$log_file")
  [ -f "$err_file" ] && files+=("$err_file")

  if [ ${#files[@]} -eq 1 ]; then
    tail -f "${files[0]}"
  else
    tail -f "${files[@]}"
  fi
}

cmd_restart() {
  check_macos

  info "Restarting disclaude LaunchAgent..."

  if [ ! -f "$PLIST_DEST" ]; then
    error "LaunchAgent plist not installed. Run './scripts/launchd-setup.sh install' first."
    exit 1
  fi

  if is_loaded; then
    launchctl unload "$PLIST_DEST"
    ok "Unloaded service."
    sleep 2
  fi

  # Re-generate plist in case paths changed (e.g., node binary moved)
  check_built
  generate_plist "$PLIST_TEMPLATE" "$PLIST_DEST"

  launchctl load "$PLIST_DEST"
  ok "Loaded service."

  sleep 2
  if is_loaded; then
    local pid
    pid=$(get_pid)
    if [ -n "$pid" ] && [ "$pid" != "-" ]; then
      ok "Service restarted (PID: ${pid})"
    else
      info "Service is loading..."
    fi
  else
    error "Service failed to restart. Check logs: ${LOG_DIR}/launchd-stderr.log"
    exit 1
  fi
}

# ============================================================================
# Main
# ============================================================================

usage() {
  echo "Usage: $0 {install|uninstall|status|logs|restart}"
  echo ""
  echo "Manage disclaude as a macOS LaunchAgent (replaces PM2 on macOS)."
  echo ""
  echo "Commands:"
  echo "  install    Build, generate plist, and start the service"
  echo "  uninstall  Stop and remove the LaunchAgent"
  echo "  status     Check if the service is running"
  echo "  logs       Tail stdout and stderr logs"
  echo "  restart    Graceful restart (unload + reload)"
  echo ""
  echo "Why launchd instead of PM2?"
  echo "  macOS TCC (Transparency, Consent, and Control) tracks the process chain."
  echo "  PM2 creates: PM2(node) → disclaude → child processes"
  echo "  launchd creates: launchd → node → disclaude (clean chain)"
  echo "  A clean process chain ensures TCC permissions (microphone, camera) work correctly."
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  restart)   cmd_restart ;;
  *)
    usage
    exit 1
    ;;
esac

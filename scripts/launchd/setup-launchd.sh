#!/usr/bin/env bash
# =============================================================================
# launchd Setup Script for Disclaude (macOS)
#
# This script manages disclaude services via macOS launchd.
# It replaces PM2 on macOS to avoid TCC (Transparency, Consent, and Control)
# permission chain issues with microphone, camera, and other protected resources.
#
# Usage:
#   ./scripts/launchd/setup-launchd.sh install [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh uninstall [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh start [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh stop [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh restart [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh status [primary|worker|all]
#   ./scripts/launchd/setup-launchd.sh logs <primary|worker> [tail]
#
# Background:
#   macOS TCC tracks the entire process chain. When running under PM2 fork mode:
#     PM2(node) → claude → zsh → python/audio-tool
#   The PM2 node ancestor lacks TCC permission, causing all descendant processes
#   to silently get zero-length data. launchd provides a clean process chain:
#     launchd → node → disclaude
#   which allows TCC permission dialogs to work correctly.
#
# Related: https://github.com/hs3180/disclaude/issues/1957
# =============================================================================

set -euo pipefail

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$PROJECT_ROOT/logs"

# Service definitions: LABEL | PLIST_TEMPLATE | DEFAULT_BINARY_PATH
SERVICES=(
    "com.disclaude.primary|com.disclaude.primary.plist.example|packages/primary-node/dist/cli.js"
    "com.disclaude.worker|com.disclaude.worker.plist.example|packages/worker-node/dist/cli.js"
)

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- Helpers ---
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

die() {
    error "$*"
    exit 1
}

# Check if running on macOS
check_macos() {
    if [[ "$(uname)" != "Darwin" ]]; then
        die "This script is for macOS only. Use PM2 on Linux."
    fi
}

# Resolve service targets from argument
resolve_targets() {
    local arg="${1:-all}"
    case "$arg" in
        primary) echo "com.disclaude.primary" ;;
        worker)  echo "com.disclaude.worker" ;;
        all)     echo "com.disclaude.primary com.disclaude.worker" ;;
        *)       die "Unknown service: $arg. Use: primary, worker, or all" ;;
    esac
}

# Find node binary path
find_node_path() {
    local node_path
    node_path="$(which node 2>/dev/null || true)"
    if [[ -z "$node_path" ]]; then
        die "Node.js not found. Please install Node.js >= 18."
    fi
    echo "$node_path"
}

# Generate plist file from template with proper paths
generate_plist() {
    local template_file="$1"
    local output_file="$2"
    local node_path
    node_path="$(find_node_path)"

    if [[ ! -f "$template_file" ]]; then
        die "Template not found: $template_file"
    fi

    sed \
        -e "s|/usr/local/bin/node|${node_path}|g" \
        -e "s|/path/to/disclaude|${PROJECT_ROOT}|g" \
        "$template_file" > "$output_file"

    info "Generated: $output_file"
}

# --- Commands ---
cmd_install() {
    check_macos
    local targets
    targets="$(resolve_targets "${1:-all}")"

    # Ensure log directory exists
    mkdir -p "$LOG_DIR"

    for label in $targets; do
        local template_file=""
        local plist_file="$LAUNCH_AGENT_DIR/${label}.plist"

        for entry in "${SERVICES[@]}"; do
            IFS='|' read -r entry_label entry_template entry_binary <<< "$entry"
            if [[ "$entry_label" == "$label" ]]; then
                template_file="$SCRIPT_DIR/$entry_template"
                break
            fi
        done

        if [[ -z "$template_file" ]]; then
            die "Unknown service: $label"
        fi

        # Stop existing service if running
        if launchctl list "$label" &>/dev/null; then
            info "Stopping existing service: $label"
            launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        fi

        # Generate and install plist
        generate_plist "$template_file" "$plist_file"

        # Load the service
        launchctl bootstrap "gui/$(id -u)" "$plist_file"
        info "Installed and started: $label"
    done

    info ""
    info "Installation complete. Services are now managed by launchd."
    info "Use '$0 status' to check service status."
    info ""
    warn "On first run, macOS may show TCC permission dialogs for microphone/camera."
    warn "Please grant these permissions when prompted."
}

cmd_uninstall() {
    check_macos
    local targets
    targets="$(resolve_targets "${1:-all}")"

    for label in $targets; do
        local plist_file="$LAUNCH_AGENT_DIR/${label}.plist"

        # Unload if running
        if launchctl list "$label" &>/dev/null; then
            info "Stopping service: $label"
            launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        fi

        # Remove plist file
        if [[ -f "$plist_file" ]]; then
            rm "$plist_file"
            info "Removed: $plist_file"
        else
            warn "Plist not found: $plist_file"
        fi
    done

    info "Uninstall complete."
}

cmd_start() {
    check_macos
    local targets
    targets="$(resolve_targets "${1:-all}")"

    for label in $targets; do
        local plist_file="$LAUNCH_AGENT_DIR/${label}.plist"
        if [[ ! -f "$plist_file" ]]; then
            warn "Service not installed: $label. Run '$0 install $label' first."
            continue
        fi
        launchctl bootstrap "gui/$(id -u)" "$plist_file" 2>/dev/null \
            || warn "Service $label may already be running."
        info "Started: $label"
    done
}

cmd_stop() {
    check_macos
    local targets
    targets="$(resolve_targets "${1:-all}")"

    for label in $targets; do
        if launchctl list "$label" &>/dev/null; then
            launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
            info "Stopped: $label"
        else
            warn "Service not running: $label"
        fi
    done
}

cmd_restart() {
    cmd_stop "${1:-all}"
    sleep 2
    cmd_start "${1:-all}"
}

cmd_status() {
    check_macos
    local targets
    targets="$(resolve_targets "${1:-all}")"

    echo ""
    printf "%-25s %-10s %-10s %s\n" "SERVICE" "PID" "STATUS" "EXIT CODE"
    printf "%-25s %-10s %-10s %s\n" "-------" "---" "------" "---------"

    for label in $targets; do
        if launchctl list "$label" &>/dev/null; then
            local pid exit_code status
            pid="$(launchctl list "$label" 2>/dev/null | awk '/PID/ {print $2; exit}')"
            exit_code="$(launchctl list "$label" 2>/dev/null | awk '/Status/ {print $2; exit}')"

            if [[ "$pid" == "-" || -z "$pid" ]]; then
                status="stopped"
            else
                status="running"
            fi

            printf "%-25s %-10s %-10s %s\n" "$label" "$pid" "$status" "$exit_code"
        else
            printf "%-25s %-10s %-10s %s\n" "$label" "-" "not found" "-"
        fi
    done
    echo ""
}

cmd_logs() {
    local service="${1:-primary}"
    local mode="${2:-}"

    local log_file
    case "$service" in
        primary) log_file="$LOG_DIR/launchd-primary-out.log" ;;
        worker)  log_file="$LOG_DIR/launchd-worker-out.log" ;;
        *)       die "Unknown service: $service. Use: primary or worker" ;;
    esac

    if [[ ! -f "$log_file" ]]; then
        warn "Log file not found: $log_file"
        warn "The service may not have been started yet."
        exit 0
    fi

    if [[ "$mode" == "tail" ]]; then
        tail -f "$log_file"
    else
        tail -100 "$log_file"
    fi
}

# --- Main ---
usage() {
    cat <<EOF
Disclaude launchd Manager (macOS)

Usage: $0 <command> [service] [options]

Commands:
    install   Install and start service(s)
    uninstall Stop and remove service(s)
    start     Start service(s)
    stop      Stop service(s)
    restart   Restart service(s)
    status    Show service status
    logs      View service logs

Services:
    primary   Primary Node (handles channels, Feishu bot)
    worker    Worker Node (handles agent execution)
    all       Both services (default)

Examples:
    $0 install all        # Install both services
    $0 restart primary    # Restart primary node only
    $0 status             # Check all service status
    $0 logs primary tail  # Tail primary node logs
    $0 uninstall all      # Remove all services

Note: This script replaces PM2 on macOS to avoid TCC permission issues.
      See: https://github.com/hs3180/disclaude/issues/1957
EOF
}

main() {
    local command="${1:-}"
    shift || true

    case "$command" in
        install)   cmd_install "${1:-all}" ;;
        uninstall) cmd_uninstall "${1:-all}" ;;
        start)     cmd_start "${1:-all}" ;;
        stop)      cmd_stop "${1:-all}" ;;
        restart)   cmd_restart "${1:-all}" ;;
        status)    cmd_status "${1:-all}" ;;
        logs)      cmd_logs "${1:-primary}" "${2:-}" ;;
        -h|--help|help) usage ;;
        *)         die "Unknown command: $command\nRun '$0 --help' for usage." ;;
    esac
}

main "$@"

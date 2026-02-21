#!/usr/bin/env bash
# =============================================================================
# Playwright Chrome CDP Startup Script
# =============================================================================
#
# Starts a Chromium browser instance with Chrome DevTools Protocol (CDP)
# enabled for remote debugging. The browser runs in headless mode and
# listens on a specified port for CDP connections.
#
# This allows Docker containers to connect to the host's browser instance
# via the CDP endpoint, enabling browser automation without running the
# browser inside the container.
#
# Usage:
#   ./scripts/start-playwright-cdp.sh [port]
#
# Arguments:
#   port  - CDP port to listen on (default: 9222)
#
# Environment Variables:
#   CDP_PORT      - Port for CDP endpoint (default: 9222)
#   CHROME_PATH   - Path to Chrome/Chromium binary (auto-detected if not set)
#
# Examples:
#   # Start on default port 9222
#   ./scripts/start-playwright-cdp.sh
#
#   # Start on custom port
#   ./scripts/start-playwright-cdp.sh 9223
#
#   # Start with environment variable
#   CDP_PORT=9224 ./scripts/start-playwright-cdp.sh
#
# =============================================================================

set -euo pipefail

# Default CDP port
CDP_PORT="${CDP_PORT:-${1:-9222}}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $*"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $*" >&2
}

# Find Chrome/Chromium binary
find_chrome_binary() {
    local candidates=(
        "google-chrome"
        "google-chrome-stable"
        "chromium"
        "chromium-browser"
        "chromium.chromium"
        "/usr/bin/google-chrome"
        "/usr/bin/google-chrome-stable"
        "/usr/bin/chromium"
        "/usr/bin/chromium-browser"
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "/Applications/Chromium.app/Contents/MacOS/Chromium"
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
        "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
    )

    if [[ -n "${CHROME_PATH:-}" ]]; then
        if [[ -x "$CHROME_PATH" || -f "$CHROME_PATH" ]]; then
            echo "$CHROME_PATH"
            return 0
        else
            log_error "CHROME_PATH is set but not found: $CHROME_PATH"
            return 1
        fi
    fi

    for binary in "${candidates[@]}"; do
        if command -v "$binary" &>/dev/null; then
            echo "$binary"
            return 0
        elif [[ -x "$binary" ]]; then
            echo "$binary"
            return 0
        fi
    done

    # Try using Playwright's bundled Chromium
    if command -v npx &>/dev/null; then
        local playwright_chromium
        playwright_chromium="$(npx playwright exec which chromium 2>/dev/null || true)"
        if [[ -n "$playwright_chromium" && -x "$playwright_chromium" ]]; then
            echo "$playwright_chromium"
            return 0
        fi
    fi

    return 1
}

# Check if port is already in use
check_port() {
    if command -v lsof &>/dev/null; then
        if lsof -i ":$CDP_PORT" &>/dev/null; then
            return 0
        fi
    elif command -v netstat &>/dev/null; then
        if netstat -tuln 2>/dev/null | grep -q ":$CDP_PORT "; then
            return 0
        fi
    elif command -v ss &>/dev/null; then
        if ss -tuln 2>/dev/null | grep -q ":$CDP_PORT "; then
            return 0
        fi
    fi
    return 1
}

# Main
main() {
    log_info "Starting Playwright Chrome CDP server..."

    # Find Chrome binary
    log_info "Searching for Chrome/Chromium binary..."
    CHROME_BIN="$(find_chrome_binary)" || {
        log_error "Chrome/Chromium binary not found!"
        log_error "Please install Chrome or set CHROME_PATH environment variable."
        log_error ""
        log_error "Install options:"
        log_error "  Ubuntu/Debian: sudo apt-get install chromium-browser"
        log_error "  macOS: brew install chromium"
        log_error "  Or download from: https://www.chromium.org/"
        exit 1
    }
    log_success "Found Chrome: $CHROME_BIN"

    # Check port availability
    if check_port; then
        log_warn "Port $CDP_PORT is already in use."
        read -p "Kill existing process and continue? [y/N] " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            log_info "Killing process on port $CDP_PORT..."
            if command -v lsof &>/dev/null; then
                lsof -ti ":$CDP_PORT" | xargs kill -9 2>/dev/null || true
            fi
            sleep 1
        else
            log_error "Aborted."
            exit 1
        fi
    fi

    # Create temp directory for Chrome user data
    local chrome_user_data
    chrome_user_data="${TMPDIR:-/tmp}/chrome-cdp-${CDP_PORT}"
    mkdir -p "$chrome_user_data"

    # Chrome arguments for CDP
    local chrome_args=(
        "--remote-debugging-port=$CDP_PORT"
        "--remote-debugging-address=0.0.0.0"
        "--headless=new"
        "--no-sandbox"
        "--disable-setuid-sandbox"
        "--disable-dev-shm-usage"
        "--disable-gpu"
        "--disable-software-rasterizer"
        "--disable-background-networking"
        "--disable-default-apps"
        "--disable-extensions"
        "--disable-sync"
        "--disable-translate"
        "--hide-scrollbars"
        "--metrics-recording-only"
        "--mute-audio"
        "--no-first-run"
        "--safebrowsing-disable-auto-update"
        "--disable-features=site-per-process"
        "--user-data-dir=$chrome_user_data"
        "about:blank"
    )

    log_info "Chrome arguments:"
    for arg in "${chrome_args[@]}"; do
        echo "  $arg"
    done
    echo

    log_success "Starting Chrome with CDP on port $CDP_PORT..."
    log_info "CDP endpoint (HTTP):  http://localhost:$CDP_PORT"
    log_info "CDP endpoint (WebSocket): ws://localhost:$CDP_PORT"
    log_info "User data: $chrome_user_data"
    echo
    log_info "Press Ctrl+C to stop the server."
    echo

    # Start Chrome
    exec "$CHROME_BIN" "${chrome_args[@]}"
}

# Trap signals for graceful shutdown
trap 'log_info "Shutting down..."; exit 0' INT TERM

main "$@"

#!/usr/bin/env bash
# =============================================================================
# Disclaude macOS launchd Uninstaller
#
# Removes the disclaude LaunchAgent from macOS.
#
# Usage:
#   ./scripts/launchd-uninstall.sh [--worker] [-y]
#
# Options:
#   --worker   Uninstall worker node instead of primary
#   -y         Skip confirmation prompt
#
# Related: #1957
# =============================================================================

set -euo pipefail

# ---- Colors ----
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' BLUE='' NC=''
fi

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }

# ---- Parse arguments ----
INSTALL_WORKER=false
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worker)
      INSTALL_WORKER=true; shift ;;
    -y)
      SKIP_CONFIRM=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--worker] [-y]"
      exit 0 ;;
    *)
      error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Determine node type ----
if [ "$INSTALL_WORKER" = true ]; then
  PLIST_LABEL="com.disclaude.worker"
else
  PLIST_LABEL="com.disclaude.primary"
fi

PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ---- Check if installed ----
if [ ! -f "$PLIST_PATH" ]; then
  warn "Plist not found: $PLIST_PATH"
  warn "LaunchAgent '$PLIST_LABEL' is not installed."
  exit 0
fi

# ---- Confirm ----
if [ "$SKIP_CONFIRM" != true ]; then
  echo ""
  read -rp "Uninstall '$PLIST_LABEL'? [y/N] " confirm
  if [[ "$confirm" != [yY]* ]]; then
    info "Cancelled."; exit 0
  fi
fi

# ---- Unload the LaunchAgent ----
info "Unloading LaunchAgent '$PLIST_LABEL'..."
launchctl unload "$PLIST_PATH" 2>&1 || {
  warn "Failed to unload (may already be stopped). Continuing..."
}

# ---- Remove the plist ----
info "Removing plist: $PLIST_PATH"
rm -f "$PLIST_PATH"

# ---- Verify ----
if ! launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
  ok "LaunchAgent '$PLIST_LABEL' uninstalled successfully."
else
  warn "LaunchAgent may still be loaded. Try:"
  warn "  launchctl bootout gui/$(id -u)/$PLIST_LABEL"
fi

echo ""
info "Logs are preserved at: ./logs/"
info "To re-install: ./scripts/launchd-install.sh"

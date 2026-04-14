#!/usr/bin/env bash
# =============================================================================
# Disclaude macOS launchd Installer
#
# Sets up disclaude as a macOS LaunchAgent, replacing PM2 for macOS deployments.
# This resolves the TCC process chain issue (#1957) where PM2 fork mode causes
# microphone and other privacy permissions to be silently denied.
#
# Usage:
#   ./scripts/launchd-install.sh [--node PATH] [--config PATH] [--install-dir PATH]
#
# Options:
#   --node PATH        Path to node binary (default: auto-detect via `which node`)
#   --config PATH      Path to disclaude config file (default: ./disclaude.config.yaml)
#   --install-dir PATH Path to disclaude installation (default: current directory)
#   --worker           Install worker node instead of primary
#   -y                 Skip confirmation prompt
#
# Related: #1957
# =============================================================================

set -euo pipefail

# ---- Colors (disable if not a terminal) ----
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
NODE_PATH=""
CONFIG_PATH=""
INSTALL_DIR=""
INSTALL_WORKER=false
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node)
      NODE_PATH="$2"; shift 2 ;;
    --config)
      CONFIG_PATH="$2"; shift 2 ;;
    --install-dir)
      INSTALL_DIR="$2"; shift 2 ;;
    --worker)
      INSTALL_WORKER=true; shift ;;
    -y)
      SKIP_CONFIRM=true; shift ;;
    -h|--help)
      echo "Usage: $0 [--node PATH] [--config PATH] [--install-dir PATH] [--worker] [-y]"
      exit 0 ;;
    *)
      error "Unknown option: $1"; exit 1 ;;
  esac
done

# ---- Resolve paths ----
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$REPO_ROOT"
fi
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"

if [ -z "$NODE_PATH" ]; then
  NODE_PATH="$(command -v node 2>/dev/null || true)"
  if [ -z "$NODE_PATH" ]; then
    error "Cannot find node. Please install Node.js or use --node PATH."
    exit 1
  fi
fi

if [ -z "$CONFIG_PATH" ]; then
  CONFIG_PATH="$INSTALL_DIR/disclaude.config.yaml"
fi

# ---- Determine node type ----
if [ "$INSTALL_WORKER" = true ]; then
  NODE_TYPE="worker"
  PLIST_LABEL="com.disclaude.worker"
  ENTRY_POINT="$INSTALL_DIR/packages/worker-node/dist/cli.js"
  ARGS=("start" "--mode" "worker")
  TEMPLATE="$REPO_ROOT/com.disclaude.worker.plist.example"
else
  NODE_TYPE="primary"
  PLIST_LABEL="com.disclaude.primary"
  ENTRY_POINT="$INSTALL_DIR/packages/primary-node/dist/cli.js"
  ARGS=("start")
  TEMPLATE="$REPO_ROOT/com.disclaude.primary.plist.example"
fi

PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

# ---- Pre-flight checks ----
info "Pre-flight checks..."

# Check macOS
if [ "$(uname)" != "Darwin" ]; then
  error "This script is for macOS only. On Linux, use PM2 instead."
  exit 1
fi

# Check template exists
if [ ! -f "$TEMPLATE" ]; then
  error "Template not found: $TEMPLATE"
  exit 1
fi

# Check entry point exists (might need build first)
if [ ! -f "$ENTRY_POINT" ]; then
  warn "Entry point not found: $ENTRY_POINT"
  warn "You may need to run 'npm run build' first."
fi

# Check config file exists
if [ ! -f "$CONFIG_PATH" ]; then
  warn "Config file not found: $CONFIG_PATH"
  warn "Make sure to create it before starting the service."
fi

# Check if already loaded
if launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
  warn "LaunchAgent '$PLIST_LABEL' is already loaded."
  warn "Run './scripts/launchd-uninstall.sh' first to remove it, or use -y to overwrite."
  if [ "$SKIP_CONFIRM" != true ]; then
    exit 1
  fi
fi

# ---- Ensure directories exist ----
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$INSTALL_DIR/logs"

# ---- Display summary ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Disclaude launchd Installer (${NODE_TYPE} node)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Node binary:    $NODE_PATH"
echo " Entry point:    $ENTRY_POINT"
echo " Config file:    $CONFIG_PATH"
echo " Working dir:    $INSTALL_DIR"
echo " Plist label:    $PLIST_LABEL"
echo " Plist output:   $PLIST_DEST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ---- Confirm ----
if [ "$SKIP_CONFIRM" != true ]; then
  read -rp "Install? [y/N] " confirm
  if [[ "$confirm" != [yY]* ]]; then
    info "Cancelled."; exit 0
  fi
fi

# ---- Generate plist ----
info "Generating plist from template..."

# Build ProgramArguments array as plist XML
ARGS_XML=""
for arg in "$NODE_PATH" "$ENTRY_POINT" "${ARGS[@]}"; do
  ARGS_XML+="    <string>${arg}</string>"$'\n'
done
ARGS_XML+="    <string>--config</string>"$'\n'
ARGS_XML+="    <string>${CONFIG_PATH}</string>"$'\n'

# Build PATH with common macOS tool locations
ENHANCED_PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Include anaconda/miniconda paths if they exist
if [ -d "$HOME/anaconda3/bin" ]; then
  ENHANCED_PATH="$HOME/anaconda3/bin:$ENHANCED_PATH"
fi
if [ -d "$HOME/anaconda/anaconda3/bin" ]; then
  ENHANCED_PATH="$HOME/anaconda/anaconda3/bin:$ENHANCED_PATH"
fi
if [ -d "$HOME/miniconda3/bin" ]; then
  ENHANCED_PATH="$HOME/miniconda3/bin:$ENHANCED_PATH"
fi

# Use sed to replace CHANGEME placeholders
sed \
  -e "s|CHANGEME: Path to your Node.js binary.*</string>|<!-- Node binary -->|g" \
  -e "s|/usr/local/bin/node|${NODE_PATH}|g" \
  -e "s|CHANGEME: Absolute path to your disclaude installation.*||g" \
  -e "s|/Users/YOUR_USERNAME/disclaude|${INSTALL_DIR}|g" \
  -e "s|CHANGEME: Include paths.*||g" \
  -e "s|/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin|${ENHANCED_PATH}|g" \
  -e "s|CHANGEME: Set your timezone.*||g" \
  "$TEMPLATE" > "$PLIST_DEST"

info "Plist written to: $PLIST_DEST"

# ---- Load the LaunchAgent ----
info "Loading LaunchAgent..."
launchctl load "$PLIST_DEST" 2>&1 || {
  error "Failed to load LaunchAgent. Check the plist for errors:"
  error "  launchctl print gui/$(id -u)/$PLIST_LABEL"
  exit 1
}

# ---- Verify ----
sleep 2
if launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
  ok "LaunchAgent '$PLIST_LABEL' loaded successfully!"
else
  warn "LaunchAgent may not be running yet. Check status with:"
  warn "  launchctl print gui/$(id -u)/$PLIST_LABEL"
fi

# ---- Post-install instructions ----
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Post-Install"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo " Verify status:"
echo "   launchctl print gui/$(id -u)/$PLIST_LABEL"
echo ""
echo " View logs:"
echo "   tail -f $INSTALL_DIR/logs/launchd-stdout.log"
echo "   tail -f $INSTALL_DIR/logs/launchd-stderr.log"
echo ""
echo " Stop service:"
echo "   ./scripts/launchd-uninstall.sh [--worker]"
echo ""
echo " Rebuild & restart after code changes:"
echo "   npm run build"
echo "   launchctl kickstart -k gui/$(id -u)/$PLIST_LABEL"
echo ""
echo " ⚠️  TCC Microphone Permission:"
echo " On first run, macOS may prompt for microphone access."
echo " The launchd process chain is: launchd → node → disclaude"
echo " This is clean and TCC-compatible (unlike PM2's chain)."
echo ""
echo " If you don't see a prompt, grant permission manually:"
echo "   System Settings → Privacy & Security → Microphone"
echo "   Look for 'node' or 'Terminal' and enable it."
echo ""

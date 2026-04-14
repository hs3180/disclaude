#!/bin/bash
# mac-control Skill Tests
#
# These tests verify the mac-control skill scripts.
# On non-macOS systems, tests will be skipped with a warning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")/skills/mac-control"
SCRIPTS_DIR="$SKILL_DIR/scripts"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS+1)); echo -e "  ${GREEN}✅ PASS${NC}: $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  ${RED}❌ FAIL${NC}: $1"; }
skip() { SKIP=$((SKIP+1)); echo -e "  ${YELLOW}⏭️ SKIP${NC}: $1"; }

check_macos() {
  [[ "$(uname)" == "Darwin" ]]
}

echo ""
echo "=== mac-control Skill Tests ==="
echo ""

# Test 1: SKILL.md exists and is well-formed
echo "Test: SKILL.md exists and has required fields"
if [ -f "$SKILL_DIR/SKILL.md" ]; then
  # Check YAML frontmatter
  if head -1 "$SKILL_DIR/SKILL.md" | grep -q "^---"; then
    if grep -q "^name: mac-control" "$SKILL_DIR/SKILL.md"; then
      pass "SKILL.md has correct name"
    else
      fail "SKILL.md missing correct name"
    fi
    if grep -q "^description:" "$SKILL_DIR/SKILL.md"; then
      pass "SKILL.md has description"
    else
      fail "SKILL.md missing description"
    fi
    if grep -q "^allowed-tools:" "$SKILL_DIR/SKILL.md"; then
      pass "SKILL.md has allowed-tools"
    else
      fail "SKILL.md missing allowed-tools"
    fi
  else
    fail "SKILL.md missing YAML frontmatter"
  fi
else
  fail "SKILL.md not found"
fi

# Test 2: SKILL.md content coverage
echo ""
echo "Test: SKILL.md covers required topics"
REQUIRED_SECTIONS=(
  "screenshot"
  "mouse"
  "keyboard"
  "Retina"
  "clipboard"
  "pbcopy"
  "cliclick"
  "osascript"
  "coordinate"
  "window"
)
for section in "${REQUIRED_SECTIONS[@]}"; do
  if grep -qi "$section" "$SKILL_DIR/SKILL.md"; then
    pass "SKILL.md covers: $section"
  else
    fail "SKILL.md missing topic: $section"
  fi
done

# Test 3: Scripts exist and are executable
echo ""
echo "Test: Helper scripts exist and are executable"
REQUIRED_SCRIPTS=(
  "mac-screenshot.sh"
  "mac-type-text.sh"
  "mac-window-info.sh"
  "mac-coord-convert.sh"
)
for script in "${REQUIRED_SCRIPTS[@]}"; do
  if [ -f "$SCRIPTS_DIR/$script" ]; then
    if [ -x "$SCRIPTS_DIR/$script" ]; then
      pass "$script exists and is executable"
    else
      fail "$script exists but is not executable"
    fi
  else
    fail "$script not found"
  fi
done

# Test 4: Script syntax validation
echo ""
echo "Test: Script syntax validation"
for script in "$SCRIPTS_DIR"/*.sh; do
  script_name=$(basename "$script")
  if bash -n "$script" 2>/dev/null; then
    pass "$script_name: valid bash syntax"
  else
    fail "$script_name: syntax error"
  fi
done

# Test 5: Scripts contain proper error handling
echo ""
echo "Test: Scripts have proper error handling"
for script in "$SCRIPTS_DIR"/*.sh; do
  script_name=$(basename "$script")
  if grep -q "set -euo pipefail" "$script" || grep -q "set -e" "$script"; then
    pass "$script_name: has error handling (set -e)"
  else
    fail "$script_name: missing error handling"
  fi
done

# Test 6: mac-type-text.sh handles non-ASCII detection
echo ""
echo "Test: mac-type-text.sh handles non-ASCII detection"
if grep -q "ASCII" "$SCRIPTS_DIR/mac-type-text.sh"; then
  pass "mac-type-text.sh has ASCII detection"
else
  fail "mac-type-text.sh missing ASCII detection"
fi
if grep -q "pbcopy" "$SCRIPTS_DIR/mac-type-text.sh"; then
  pass "mac-type-text.sh uses pbcopy for clipboard"
else
  fail "mac-type-text.sh missing pbcopy"
fi
if grep -q "pbpaste" "$SCRIPTS_DIR/mac-type-text.sh"; then
  pass "mac-type-text.sh saves/restores clipboard"
else
  fail "mac-type-text.sh missing clipboard backup/restore"
fi

# Test 7: mac-coord-convert.sh handles scale conversion
echo ""
echo "Test: mac-coord-convert.sh scale conversion"
if grep -q "scale_factor" "$SCRIPTS_DIR/mac-coord-convert.sh" || grep -q "SCALE" "$SCRIPTS_DIR/mac-coord-convert.sh"; then
  pass "mac-coord-convert.sh handles scale factor"
else
  fail "mac-coord-convert.sh missing scale factor handling"
fi
if grep -q "cliclick" "$SCRIPTS_DIR/mac-coord-convert.sh"; then
  pass "mac-coord-convert.sh outputs cliclick command"
else
  fail "mac-coord-convert.sh missing cliclick command output"
fi

# Test 8: mac-screenshot.sh outputs JSON
echo ""
echo "Test: mac-screenshot.sh outputs JSON metadata"
if grep -q '"path"' "$SCRIPTS_DIR/mac-screenshot.sh"; then
  pass "mac-screenshot.sh outputs path"
else
  fail "mac-screenshot.sh missing path output"
fi
if grep -q '"scaleFactor"' "$SCRIPTS_DIR/mac-screenshot.sh"; then
  pass "mac-screenshot.sh outputs scaleFactor"
else
  fail "mac-screenshot.sh missing scaleFactor output"
fi

# Test 9: mac-window-info.sh outputs JSON
echo ""
echo "Test: mac-window-info.sh outputs JSON window info"
if grep -q '"bounds"' "$SCRIPTS_DIR/mac-window-info.sh"; then
  pass "mac-window-info.sh outputs bounds"
else
  fail "mac-window-info.sh missing bounds output"
fi
if grep -q '"center"' "$SCRIPTS_DIR/mac-window-info.sh"; then
  pass "mac-window-info.sh outputs center point"
else
  fail "mac-window-info.sh missing center output"
fi

# Test 10: CJK input guidance in SKILL.md
echo ""
echo "Test: CJK/Chinese text input guidance"
if grep -q "pbcopy" "$SKILL_DIR/SKILL.md" && grep -q "中文" "$SKILL_DIR/SKILL.md"; then
  pass "SKILL.md has Chinese text input guidance with pbcopy"
else
  fail "SKILL.md missing Chinese text input guidance"
fi

# macOS-specific tests (skipped on other platforms)
if check_macos; then
  echo ""
  echo "=== macOS-Specific Integration Tests ==="
  echo ""

  # Test: cliclick is available
  if command -v cliclick &>/dev/null; then
    pass "cliclick is installed"
  else
    skip "cliclick not installed (brew install cliclick)"
  fi

  # Test: screencapture works
  echo ""
  echo "Test: screencapture command"
  if screencapture -x /tmp/_test_screenshot.png 2>/dev/null; then
    pass "screencapture works"
    rm -f /tmp/_test_screenshot.png
  else
    fail "screencapture failed (may need Screen Recording permission)"
  fi
else
  echo ""
  echo "=== macOS Integration Tests: SKIPPED (not running on macOS) ==="
fi

# Summary
echo ""
echo "=== Test Summary ==="
echo -e "  ${GREEN}PASS${NC}: $PASS"
echo -e "  ${RED}FAIL${NC}: $FAIL"
echo -e "  ${YELLOW}SKIP${NC}: $SKIP"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}Some tests failed!${NC}"
  exit 1
else
  echo -e "${GREEN}All tests passed!${NC}"
  exit 0
fi

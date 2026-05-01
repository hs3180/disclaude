---
name: mac-control
description: "macOS native screen/keyboard/mouse control via CGEvent + AppleScript. Hardware-level automation for desktop apps (Feishu, Chrome, Electron). Handles Retina coordinates, CJK text input, window management. Use when browser automation (CDP/Playwright) fails."
allowed-tools: Bash, Read, Glob, Grep
---

# Mac Control — Hardware-Level Desktop Automation

Control macOS desktop applications via CGEvent (CoreGraphics) hardware events and AppleScript. Works with **all** apps — browsers, Electron, native macOS — because CGEvent injects events at the HID layer, identical to physical mouse/keyboard.

## Requirements

- **macOS** only (uses CoreGraphics framework)
- **Accessibility permission**: System Settings → Privacy & Security → Accessibility → add your terminal app
- **Python 3** (stdlib only, zero pip dependencies)

## Quick Start

```bash
# First run: check environment and calibrate
python3 skills/mac-control/scripts/macos-ctl.py calibrate

# Click at screen coordinates (500, 300)
python3 skills/mac-control/scripts/macos-ctl.py click 500 300

# Get a window's position
python3 skills/mac-control/scripts/macos-ctl.py window "Google Chrome"
# → Google Chrome: x=0, y=38, w=1440, h=860

# Type text (supports Chinese, emoji, any Unicode)
python3 skills/mac-control/scripts/macos-ctl.py type "你好世界 Hello 🌍"
```

## Core Workflow: Screenshot → Analyze → Act → Verify

**This is the recommended pattern for all interactions:**

```bash
# 1. Capture screenshot
/usr/sbin/screencapture -x /tmp/screen.png

# 2. Analyze (use Read tool on the image to find target coordinates)

# 3. Act (click, type, etc.)
python3 skills/mac-control/scripts/macos-ctl.py click X Y

# 4. Verify (screenshot again)
/usr/sbin/screencapture -x /tmp/after.png
# Read /tmp/after.png to confirm result
```

## Coordinate System

### Understanding Retina Scaling

| Coordinate Type | Source | Scale |
|----------------|--------|-------|
| **Physical pixels** | Screenshots, image analysis | 2x on Retina |
| **Logical pixels** | CGEvent, cliclick, osascript | 1x (native) |

**Conversion formula:**
```
logical_coord = screenshot_coord / scale_factor
```

Most Macs have `scale_factor = 2`. Non-Retina displays use `scale_factor = 1`.

```bash
# Check your scale factor
python3 skills/mac-control/scripts/macos-ctl.py scale-factor

# Full calibration
python3 skills/mac-control/scripts/macos-ctl.py calibrate
```

### Example: Clicking a Screenshot Coordinate

If the screenshot shows a button at physical pixel (1600, 900) on a 2x Retina display:
```bash
# Convert: 1600/2 = 800, 900/2 = 450
python3 skills/mac-control/scripts/macos-ctl.py click 800 450
```

## Mouse Control

```bash
# Left click
python3 skills/mac-control/scripts/macos-ctl.py click 500 300

# Double click
python3 skills/mac-control/scripts/macos-ctl.py doubleclick 500 300

# Right click
python3 skills/mac-control/scripts/macos-ctl.py rightclick 500 300

# Move without clicking (hover)
python3 skills/mac-control/scripts/macos-ctl.py move 500 300

# Drag from (100, 200) to (500, 300)
python3 skills/mac-control/scripts/macos-ctl.py drag 100 200 500 300
```

## Text Input (CJK-Safe)

**Problem**: CGEvent keyboard events don't support Chinese/composed characters.
**Solution**: Clipboard paste (`pbcopy` + Cmd+V) — handles all Unicode reliably.

```bash
# Type any text (Chinese, emoji, special chars all work)
python3 skills/mac-control/scripts/macos-ctl.py type "你好世界 🎉"

# Press specific keys
python3 skills/mac-control/scripts/macos-ctl.py key return
python3 skills/mac-control/scripts/macos-ctl.py key tab
python3 skills/mac-control/scripts/macos-ctl.py key escape

# Key with modifiers
python3 skills/mac-control/scripts/macos-ctl.py key w cmd          # Cmd+W (close window)
python3 skills/mac-control/scripts/macos-ctl.py key a cmd           # Cmd+A (select all)
python3 skills/mac-control/scripts/macos-ctl.py key c cmd           # Cmd+C (copy)
python3 skills/mac-control/scripts/macos-ctl.py key v cmd           # Cmd+V (paste)
python3 skills/mac-control/scripts/macos-ctl.py key s cmd,shift     # Cmd+Shift+S
```

### Type-Then-Enter Pattern

```bash
# Click to focus input field
python3 skills/mac-control/scripts/macos-ctl.py click 500 300
sleep 0.2

# Type text
python3 skills/mac-control/scripts/macos-ctl.py type "搜索关键词"

# Press Enter to submit
python3 skills/mac-control/scripts/macos-ctl.py key return
```

## Window Management

```bash
# Get front window bounds
python3 skills/mac-control/scripts/macos-ctl.py window "Feishu"
# → Feishu: x=0, y=38, w=1440, h=860

# List all windows of an app (with titles)
python3 skills/mac-control/scripts/macos-ctl.py windows "Google Chrome"
# → [0] x=0, y=38, w=1440, h=860 "GitHub"
# → [1] x=200, y=100, w=800, h=600 "Google"

# Bring app to foreground
python3 skills/mac-control/scripts/macos-ctl.py activate "Feishu"

# List all running apps
python3 skills/mac-control/scripts/macos-ctl.py list-apps
```

### Window-Relative Clicking

```bash
# Get window bounds
python3 skills/mac-control/scripts/macos-ctl.py window "Feishu"
# → x=100, y=50, w=800, h=600

# To click at window-relative position (200, 300):
# screen_x = window_x + relative_x = 100 + 200 = 300
# screen_y = window_y + relative_y = 50 + 300 = 350
python3 skills/mac-control/scripts/macos-ctl.py click 300 350
```

## Screenshots

```bash
# Full screen capture (silent, no sound)
/usr/sbin/screencapture -x /tmp/screen.png

# Capture specific app window
python3 skills/mac-control/scripts/macos-ctl.py screenshot-window "Feishu" /tmp/feishu.png

# With cursor visible
/usr/sbin/screencapture -C -x /tmp/with-cursor.png

# Delayed capture (3 seconds)
/usr/sbin/screencapture -T 3 -x /tmp/delayed.png
```

## Common Patterns

### Control Feishu (飞书) Desktop App

```bash
# 1. Activate Feishu
python3 skills/mac-control/scripts/macos-ctl.py activate "Feishu"
sleep 0.5

# 2. Get window position
python3 skills/mac-control/scripts/macos-ctl.py window "Feishu"

# 3. Screenshot to find UI elements
/usr/sbin/screencapture -x /tmp/feishu.png
# (Read tool on /tmp/feishu.png to locate search bar, buttons, etc.)

# 4. Click search bar (example: at logical coords 400, 80)
python3 skills/mac-control/scripts/macos-ctl.py click 400 80
sleep 0.3

# 5. Type search text (Chinese works via clipboard paste)
python3 skills/mac-control/scripts/macos-ctl.py type "目标群聊名称"
sleep 0.5

# 6. Press Enter to confirm
python3 skills/mac-control/scripts/macos-ctl.py key return

# 7. Verify result
/usr/sbin/screencapture -x /tmp/feishu-result.png
```

### Navigate File Dialogs

```bash
# CGEvent triggers dialog, AppleScript navigates it

# 1. Click to open file dialog
python3 skills/mac-control/scripts/macos-ctl.py click 750 400
sleep 1

# 2. Open "Go to Folder" (Cmd+Shift+G)
python3 skills/mac-control/scripts/macos-ctl.py key g cmd,shift
sleep 1

# 3. Paste file path
echo -n "/path/to/file.png" | pbcopy
python3 skills/mac-control/scripts/macos-ctl.py key v cmd
sleep 0.5

# 4. Press Enter to navigate
python3 skills/mac-control/scripts/macos-ctl.py key return
sleep 1.5

# 5. Press Enter again to open
python3 skills/mac-control/scripts/macos-ctl.py key return
```

### Keyboard Navigation (When Clicks Fail)

Some pages (Google OAuth, security dialogs) block synthetic mouse clicks. Use keyboard navigation instead:

```bash
# Tab through elements
python3 skills/mac-control/scripts/macos-ctl.py key tab
sleep 0.15

# Activate focused element
python3 skills/mac-control/scripts/macos-ctl.py key return

# Full workflow: Tab 3 times then Enter
for i in 1 2 3; do
  python3 skills/mac-control/scripts/macos-ctl.py key tab
  sleep 0.15
done
python3 skills/mac-control/scripts/macos-ctl.py key return
```

### Multi-Step UI Automation

```bash
# Screenshot → identify → click → repeat
/usr/sbin/screencapture -x /tmp/step1.png
# Read image, find target at logical (500, 300)
python3 skills/mac-control/scripts/macos-ctl.py click 500 300
sleep 1

/usr/sbin/screencapture -x /tmp/step2.png
# Read image, find next target at logical (600, 400)
python3 skills/mac-control/scripts/macos-ctl.py click 600 400
sleep 1

# Verify final state
/usr/sbin/screencapture -x /tmp/final.png
```

## Method Comparison

| Method | Web Clicks | File Dialogs | Native UI | CJK Input | Electron |
|--------|-----------|-------------|-----------|-----------|----------|
| CDP `.click()` | ✅ | ❌ | ❌ | — | ❌ |
| AppleScript `click button` | ✅ (a11y) | ✅ | ✅ | — | Partial |
| **CGEvent** | **✅** | **✅** | **✅** | ✅ (clipboard) | **✅** |
| Playwright | ✅ | ❌ | ❌ | ✅ | ❌ |

**CGEvent wins** because it operates at the hardware event layer — apps can't distinguish it from real mouse input.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "CoreGraphics not found" | This tool requires macOS. Cannot run on Linux/Windows. |
| Clicks land in wrong position | Run `calibrate` to check scale factor. Convert screenshot coords to logical coords. |
| Permission denied | System Settings → Privacy & Security → Accessibility → add your terminal app |
| Clicks ignored on OAuth pages | Use keyboard navigation (Tab + Enter) instead |
| Chinese text garbled | Always use `type` command (clipboard paste), never raw key events |
| Window not found | Use `list-apps` to check exact app name. Names are case-sensitive. |
| Multiple windows confusion | Use `windows` command to list all, then target the right one by title |
| Events silently dropped | Accessibility permission not granted. Check System Settings. |

## Important Notes

1. **Always re-measure before clicking** — windows move, dialogs appear, layouts shift
2. **Use `sleep` between actions** — UI needs 0.2-1.5s to respond
3. **Activate the target app first** for reliable keyboard input
4. **Screenshot → click → screenshot** is the safest workflow
5. **Clipboard paste** is the only reliable method for non-ASCII text input
6. **This skill only works on macOS** — check platform before attempting automation

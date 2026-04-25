---
name: mac-control
description: Mac screen control capability - automate mouse clicks, keyboard input, screenshots, and window management on macOS. Use when user wants to control desktop applications, automate GUI interactions, or perform screen-based tasks on Mac.
allowed-tools: Read, Write, Bash
---

# Mac Control Skill

AI Agent skill for controlling macOS desktop applications via mouse, keyboard, and screenshots.

> **Platform**: macOS only. Requires Accessibility permission (System Settings → Privacy & Security → Accessibility).

## Quick Start

```bash
# Take a screenshot
python3 scripts/mac_control.py screenshot --output /tmp/screen.png

# Click at coordinates
python3 scripts/mac_control.py click --x 500 --y 300

# Type text (supports Chinese/CJK via clipboard paste)
python3 scripts/mac_control.py type --text "Hello 世界"

# Get window bounds
python3 scripts/mac_control.py window --app "Safari"

# Activate an app
python3 scripts/mac_control.py activate --app "飞书"

# Calibrate Retina display
python3 scripts/mac_control.py calibrate
```

## Capabilities

| Action | Command | Notes |
|--------|---------|-------|
| Screenshot | `screenshot` | Optional region crop, cursor toggle |
| Click | `click --x X --y Y` | Left/right, single/double |
| Move | `move --x X --y Y` | Move without clicking |
| Drag | `drag --from-x X1 --from-y Y1 --to-x X2 --to-y Y2` | Smooth interpolation |
| Type text | `type --text "..."` | Clipboard paste method (CJK safe) |
| Key press | `key --key return --modifiers cmd` | Full keyboard support |
| Window info | `window --app "Safari"` | Bounds, position, size |
| Activate app | `activate --app "飞书"` | Bring to foreground |
| Calibrate | `calibrate` | Detect Retina scaling |

## Typical Workflow

### Screenshot → Analyze → Click → Verify

1. **Screenshot**: Capture the current screen state
2. **Analyze**: Read the screenshot image to identify target elements and their coordinates
3. **Click/Type**: Perform the desired action at the identified coordinates
4. **Verify**: Take another screenshot to confirm the result

### Example: Send a message in Feishu

```
1. Activate Feishu:     python3 scripts/mac_control.py activate --app "飞书"
2. Take screenshot:     python3 scripts/mac_control.py screenshot --output /tmp/feishu.png
3. Analyze screenshot:  [Read the image to find the message input box]
4. Click input box:     python3 scripts/mac_control.py click --x 500 --y 800
5. Type message:        python3 scripts/mac_control.py type --text "Hello from AI"
6. Press Enter:         python3 scripts/mac_control.py key --key return
7. Verify:              python3 scripts/mac_control.py screenshot --output /tmp/verify.png
```

## Coordinate System

All coordinates use **logical points** (Quartz coordinate space), not pixels.

- **Retina displays**: The `calibrate` command detects the scale factor. Divide pixel coordinates from screenshots by the scale factor to get logical points.
- **Origin**: Top-left corner of the **main display** is (0, 0).
- **Multi-display**: Coordinates extend across displays (may be negative for left-side displays).

## Text Input

The `type` command uses the **clipboard paste method** (`pbcopy` + `Cmd+V`) which:
- ✅ Supports CJK characters (Chinese, Japanese, Korean)
- ✅ Supports emoji and special characters
- ✅ Bypasses IME interception issues
- ✅ Preserves original clipboard contents after typing

## Requirements

1. **macOS 10.9+** with Python 3.8+
2. **Accessibility Permission**: The calling process (Terminal, VS Code, etc.) must be granted Accessibility access in System Settings → Privacy & Security → Accessibility
3. **Zero external dependencies**: Only Python stdlib (ctypes, subprocess) is used

## Technical Details

### Mouse Control
Uses `CoreGraphics.CGEvent` directly via Python ctypes — no cliclick or other wrappers needed.

### Screenshot
Uses the built-in `screencapture` command with region cropping support.

### Window Management
Uses `osascript` with System Events to query window bounds and activate applications.

### Keyboard Input
- **Text**: Clipboard paste (`pbcopy` + Cmd+V via CGEvent) — handles all Unicode including CJK
- **Key presses**: CGEvent key events with full modifier key support

## Limitations

- macOS only (uses CoreGraphics/System Events)
- Requires Accessibility permission grant
- Cannot interact with login window or Screen Saver
- Some apps (e.g., System Preferences) may have limited Accessibility support
- Remote/headless servers without a GUI are not supported

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 | Basic tools (mouse, screenshot, calibration, window) | ✅ Implemented |
| Phase 2 | Text input (clipboard paste, keyboard shortcuts) | ✅ Implemented |
| Phase 3 | UI interaction (Accessibility API element finding, visual location) | 🔲 Planned |
| Phase 4 | Full Agent integration (automated workflows) | 🔲 Planned |

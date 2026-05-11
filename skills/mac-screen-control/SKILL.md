---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: [Bash, Read, Write]
---

# Mac Screen Control

Control macOS desktop applications through Accessibility API and CGEvent hardware-level events.

## Single Responsibility

- ✅ Take screenshots of full screen or specific regions
- ✅ Click, double-click, right-click, and drag at coordinates
- ✅ Type text including CJK characters (Chinese, Japanese, Korean)
- ✅ Press keyboard shortcuts with modifiers (Cmd, Shift, Alt, Ctrl)
- ✅ Get window bounds and activate applications
- ✅ Find UI elements via Accessibility API
- ✅ Calibrate Retina display coordinates
- ❌ DO NOT control remote servers (macOS only)
- ❌ DO NOT bypass authentication or security prompts
- ❌ DO NOT perform destructive file operations through GUI automation

## Prerequisites

- **Platform**: macOS only (uses CoreGraphics and Accessibility APIs)
- **Permissions**: System Settings → Privacy & Security → Accessibility (must be granted)
- **Python**: 3.8+ (pre-installed on macOS)
- **No pip dependencies**: Uses only stdlib + ctypes for CGEvent

## Usage

All operations go through the `mac-screen-control.py` helper script:

```bash
# Screenshot (full screen or region)
python3 skills/mac-screen-control/mac-screen-control.py screenshot [--output /tmp/shot.png] [--region x,y,w,h]

# Mouse operations
python3 skills/mac-screen-control/mac-screen-control.py click --x 100 --y 200
python3 skills/mac-screen-control/mac-screen-control.py click --x 100 --y 200 --button right
python3 skills/mac-screen-control/mac-screen-control.py click --x 100 --y 200 --double
python3 skills/mac-screen-control/mac-screen-control.py move --x 100 --y 200
python3 skills/mac-screen-control/mac-screen-control.py drag --from-x 100 --from-y 100 --to-x 300 --to-y 300

# Keyboard input
python3 skills/mac-screen-control/mac-screen-control.py type --text "Hello 你好"
python3 skills/mac-screen-control/mac-screen-control.py key --key return
python3 skills/mac-screen-control/mac-screen-control.py key --key c --modifiers cmd
python3 skills/mac-screen-control/mac-screen-control.py key --key tab --modifiers cmd

# Window management
python3 skills/mac-screen-control/mac-screen-control.py window --app "Google Chrome" --bounds
python3 skills/mac-screen-control/mac-screen-control.py window --app "Feishu" --activate

# UI element finding
python3 skills/mac-screen-control/mac-screen-control.py find-element --app "Safari" --role button --name "Submit"

# Coordinate calibration
python3 skills/mac-screen-control/mac-screen-control.py calibrate
```

## Workflow: Screenshot → Analyze → Act → Verify

The recommended workflow for any UI automation task:

1. **Screenshot**: Capture the current screen state
2. **Analyze**: Read the screenshot image to identify target elements and coordinates
3. **Act**: Click, type, or perform the desired action at the identified coordinates
4. **Verify**: Take another screenshot to confirm the action succeeded
5. **Repeat**: Continue with the next step if needed

### Important: Coordinate System

- All coordinates are in **logical points** (not Retina pixels)
- Screenshot images may be 2x resolution on Retina displays
- Use `calibrate` to detect the current scale factor
- When reading coordinates from a screenshot: `click_x = pixel_x / scale_factor`

### Text Input (CJK Support)

For typing Chinese/Japanese/Korean text, the script uses the **clipboard method**:
1. Saves current clipboard content
2. Copies the text to clipboard via `pbcopy`
3. Simulates Cmd+V to paste
4. Restores original clipboard content

This bypasses IME interception issues that affect `keystroke`-based methods.

## Key Mappings

Common key names for the `key` command:

| Key | Name | Key | Name |
|-----|------|-----|------|
| Return | `return` | Tab | `tab` |
| Space | `space` | Delete | `delete` |
| Backspace | `backspace` | Escape | `escape` |
| Up | `up` | Down | `down` |
| Left | `left` | Right | `right` |
| Home | `home` | End | `end` |
| Page Up | `pageup` | Page Down | `pagedown` |
| F1-F12 | `f1`-`f12` | Caps Lock | `capslock` |

Modifiers: `cmd`, `shift`, `alt` (Option), `ctrl`

## Safety Guidelines

1. **Always verify before acting**: Take a screenshot first to confirm coordinates
2. **Small movements preferred**: Move mouse before clicking to verify position
3. **Clipboard restoration**: The script saves/restores clipboard for CJK input
4. **Timeout**: Operations have a 10-second timeout to prevent hanging
5. **No auto-dismiss**: Do not auto-dismiss system dialogs or security prompts
6. **Human oversight**: For critical operations, pause and show the user the plan first

## Error Handling

- If Accessibility permission is missing, the script prints a clear error message with instructions
- If coordinates are outside screen bounds, the operation is rejected
- If the target app is not running, `window --activate` will fail with a clear message
- If `find-element` returns no results, try alternative criteria or use coordinate-based clicking

## Architecture

```
mac-screen-control.py
├── Screenshot    → screencapture CLI
├── Mouse         → CGEvent via ctypes (CoreGraphics framework)
├── Keyboard      → CGEvent for key events + clipboard paste for CJK
├── Window        → osascript (AppleScript) for window info
├── Elements      → Accessibility API via osascript
└── Calibration   → NSScreen.main.backingScaleFactor via Python ctypes
```

No external dependencies. Only uses macOS built-in frameworks (CoreGraphics, Cocoa) via Python ctypes.

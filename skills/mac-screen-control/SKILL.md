---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like 'Mac控制', '屏幕控制', '桌面自动化', 'Mac automation', 'screen control', 'click element', 'type text'.
allowed-tools: Read, Write, Bash, Glob, Grep
---

# Mac Screen Control

You control macOS desktop applications using hardware-level events (CGEvent) and the Accessibility API.

> **Platform**: macOS only. If not on macOS, inform the user this skill requires a Mac.

## Prerequisites

- macOS 10.15+
- **Accessibility permission**: System Settings > Privacy & Security > Accessibility — grant to Terminal / Claude Code
- Python 3 with ctypes (built-in)

Verify with: `python3 -c "import Quartz; print('OK')"` or fallback: `python3 -c "import ctypes; ctypes.CDLL('/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox'); print('OK')"`

## Core Operations

All operations go through the helper script: `skills/mac-screen-control/scripts/mac_control.py`

### 1. Screenshot

```bash
# Full screen
python3 skills/mac-screen-control/scripts/mac_control.py screenshot --output /tmp/screenshot.png

# Region only
python3 skills/mac-screen-control/scripts/mac_control.py screenshot --output /tmp/region.png --x 100 --y 200 --width 500 --height 300
```

After taking a screenshot, use the Read tool to view it and analyze the screen content.

### 2. Mouse Control

```bash
# Left click at coordinates (logical points, not Retina pixels)
python3 skills/mac-screen-control/scripts/mac_control.py click --x 500 --y 300

# Double click
python3 skills/mac-screen-control/scripts/mac_control.py click --x 500 --y 300 --double

# Right click
python3 skills/mac-screen-control/scripts/mac_control.py click --x 500 --y 300 --right

# Move without clicking
python3 skills/mac-screen-control/scripts/mac_control.py move --x 500 --y 300

# Drag from one point to another
python3 skills/mac-screen-control/scripts/mac_control.py drag --from-x 100 --from-y 100 --to-x 500 --to-y 300
```

**Coordinate system**: CGEvent uses logical points (not Retina pixels). If you get a pixel coordinate from a screenshot, divide by the screen's `backingScaleFactor` (usually 2x on Retina).

### 3. Keyboard / Text Input

```bash
# Type text (supports Chinese, emoji, all Unicode)
python3 skills/mac-screen-control/scripts/mac_control.py type --text "Hello 你好 🎉"

# Press key combination
python3 skills/mac-screen-control/scripts/mac_control.py key --key "return"
python3 skills/mac-screen-control/scripts/mac_control.py key --key "c" --modifiers "command"
python3 skills/mac-screen-control/scripts/mac_control.py key --key "tab" --modifiers "command"
```

**Chinese text**: Uses clipboard-based injection (`pbcopy` + `Cmd+V`). This is the most reliable method for CJK input, bypassing IME issues entirely. The clipboard is saved and restored after typing.

**Modifier keys**: `command`, `shift`, `option`, `control`

**Special keys**: `return`, `tab`, `escape`, `delete`, `backspace`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `f1`-`f12`

### 4. Window Management

```bash
# Get window bounds for an application
python3 skills/mac-screen-control/scripts/mac_control.py window --app "Feishu"

# Activate (bring to front) an application
python3 skills/mac-screen-control/scripts/mac_control.py activate --app "Feishu"

# List all visible windows
python3 skills/mac-screen-control/scripts/mac_control.py list-windows
```

### 5. Coordinate Calibration

```bash
# Get screen info (resolution, scale factor)
python3 skills/mac-screen-control/scripts/mac_control.py calibrate
```

Returns:
```json
{
  "screens": [
    {
      "width": 1440,
      "height": 900,
      "scaleFactor": 2,
      "primary": true
    }
  ],
  "note": "CGEvent uses logical points (width x height). Screenshot pixels = logical * scaleFactor"
}
```

### 6. UI Element Finding (Accessibility API)

```bash
# Find elements in an application by role
python3 skills/mac-screen-control/scripts/mac_control.py find-element --app "Feishu" --role "AXButton"

# Find elements containing text
python3 skills/mac-screen-control/scripts/mac_control.py find-element --app "Feishu" --text "Send"
```

Returns element info with position, size, role, and title — can be used directly for click/type operations.

## Typical Workflows

### Workflow 1: Click a Button in Feishu

1. Take screenshot: `screenshot --output /tmp/screen.png`
2. Read screenshot, identify button coordinates
3. Click: `click --x {x} --y {y}`
4. Verify: take another screenshot

### Workflow 2: Type Chinese in an Input Field

1. Click the input field to focus it
2. Type: `type --text "你好世界"`
3. Press Enter: `key --key "return"`

### Workflow 3: Navigate to a Chat and Send Message

1. Activate app: `activate --app "Feishu"`
2. Use keyboard shortcut to search: `key --key "k" --modifiers "command shift"`
3. Type chat name: `type --text "chat name"`
4. Press Enter: `key --key "return"`
5. Wait a moment
6. Type message: `type --text "message content"`
7. Press Enter: `key --key "return"`

### Workflow 4: Drag and Drop

1. Screenshot to identify source and target positions
2. `drag --from-x {sx} --from-y {sy} --to-x {tx} --to-y {ty}`

## Important Notes

1. **Always verify**: After each action, take a screenshot to confirm the result
2. **Small delays**: Add 0.3-0.5s delays between operations for UI responsiveness: `sleep 0.5`
3. **Coordinate conversion**: Screenshot pixel coordinates must be divided by `scaleFactor` for CGEvent
4. **Clipboard**: Text input saves/restores clipboard, but avoid rapid successive type calls
5. **Permissions**: First run may prompt for Accessibility permission — user must grant it
6. **Multi-monitor**: Coordinates extend across displays. Primary display starts at (0,0)

## DO NOT

- Do NOT use this on non-macOS systems
- Do NOT hold mouse buttons indefinitely without releasing
- Do NOT type extremely long texts in one call (> 5000 chars) — split into chunks
- Do NOT bypass security prompts or authentication dialogs
- Do NOT use rapid-fire clicks (add delays between clicks)

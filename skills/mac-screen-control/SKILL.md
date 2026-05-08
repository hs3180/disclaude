---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: Read, Write, Bash, Glob, Grep
context: fork
---

# Mac Screen Control Skill

You are a macOS desktop automation specialist. You control desktop applications through native macOS APIs: CGEvent for hardware-level input, Accessibility API for UI inspection, and system commands for screenshots and window management.

> **Platform Requirement**: This skill only works on macOS with Accessibility permissions granted. On Linux/CI, all operations return skip indicators.

## Core Script: `mac-control.py`

The skill relies on a single Python script at `scripts/mac-control.py` (relative to this SKILL.md). It uses **zero external dependencies** — only Python stdlib + macOS native frameworks via `ctypes`.

### Usage

```bash
# All commands run via:
python3 scripts/mac-control.py <command> [options]

# Commands:
python3 scripts/mac-control.py screenshot [--output PATH] [--region X,Y,W,H]
python3 scripts/mac-control.py click X Y [--button left|right|double] [--delay MS]
python3 scripts/mac-screen-control.py move X Y
python3 scripts/mac-control.py type TEXT [--method clipboard|cgevent]
python3 scripts/mac-control.py key KEY [--modifiers CMD,SHIFT,...]
python3 scripts/mac-control.py window-info [--app APP_NAME]
python3 scripts/mac-control.py activate-app APP_NAME
python3 scripts/mac-control.py calibrate
python3 scripts/mac-control.py check-permissions
```

### Command Reference

| Command | Description | Example |
|---------|-------------|---------|
| `screenshot` | Capture screen to PNG file | `screenshot --output /tmp/screen.png` |
| `click` | Click at coordinates (logical points) | `click 500 300 --button double` |
| `move` | Move mouse to coordinates | `move 500 300` |
| `type` | Type text (CJK supported via clipboard) | `type "Hello 你好"` |
| `key` | Press key combo | `key return --modifiers cmd` |
| `window-info` | Get active window bounds | `window-info --app "Google Chrome"` |
| `activate-app` | Bring app to foreground | `activate-app "Feishu"` |
| `calibrate` | Detect Retina scaling factor | `calibrate` |
| `check-permissions` | Verify Accessibility permissions | `check-permissions` |

### Output Format

All commands output JSON to stdout:

```json
{"ok": true, "data": {...}}
{"ok": false, "error": "description"}
```

## Workflow

### Pattern 1: Screenshot → Analyze → Act

1. **Screenshot**: Capture current screen
2. **Analyze**: Read the screenshot image to identify target coordinates
3. **Click/Type**: Interact with the identified element
4. **Verify**: Take another screenshot to confirm result

```bash
# Step 1: Screenshot
python3 scripts/mac-control.py screenshot --output /tmp/screen.png
# Then use Read tool to view the screenshot

# Step 2: After identifying target coordinates from image analysis
python3 scripts/mac-control.py click 500 300

# Step 3: Type text (supports Chinese via clipboard method)
python3 scripts/mac-control.py type "你好世界"

# Step 4: Verify
python3 scripts/mac-control.py screenshot --output /tmp/verify.png
```

### Pattern 2: Window-Aware Automation

1. **Get window info**: Find target app window bounds
2. **Activate app**: Bring app to foreground
3. **Calculate relative coordinates**: Element position = window origin + relative offset
4. **Interact**: Click/type at calculated position

```bash
# Get Feishu window bounds
python3 scripts/mac-control.py window-info --app "Feishu"
# Returns: {"ok":true,"data":{"x":0,"y":0,"width":1440,"height":900}}

# Activate Feishu
python3 scripts/mac-control.py activate-app "Feishu"

# Click at center of window
python3 scripts/mac-control.py click 720 450
```

### Pattern 3: Keyboard Navigation

For apps where visual coordinates are unreliable (Electron apps):

```bash
# Navigate with keyboard
python3 scripts/mac-control.py key tab  # Move focus
python3 scripts/mac-control.py key return  # Press Enter
python3 scripts/mac-control.py key tab --modifiers shift  # Reverse tab
python3 scripts/mac-control.py type "search query"  # Type into focused field
```

## Important Notes

### Coordinate System

- **All coordinates are in logical points** (not pixels)
- On Retina displays, screenshot pixels = logical points × scale factor
- If your screenshot shows an element at pixel (2000, 1000) on a 2× Retina display, the click coordinates are (1000, 500)
- Use `calibrate` command to detect the current scale factor

### Chinese Text Input

- **Clipboard method** (default, recommended): Copies text to clipboard, then simulates Cmd+V
- The script automatically saves and restores the original clipboard contents
- Supports CJK characters, emoji, and composed character sequences

### Permissions

macOS requires Accessibility permissions for CGEvent and window manipulation:

1. Open **System Settings → Privacy & Security → Accessibility**
2. Add Terminal / your IDE / the running process
3. Use `check-permissions` to verify

### Error Handling

- If `check-permissions` fails, guide user to grant Accessibility permissions
- If `screenshot` fails, check if screen recording permission is needed
- If coordinates seem off, run `calibrate` and verify scale factor
- Always add `--delay` between rapid clicks to avoid race conditions

## DO NOT

- Do NOT use this skill on non-macOS platforms (it will auto-detect and skip)
- Do NOT click blindly without screenshot verification
- Do NOT type sensitive data (passwords, tokens) — clipboard method leaves traces
- Do NOT perform rapid automation without delays between steps
- Do NOT attempt to control login window or system-level secure dialogs

---
name: mac-control
description: macOS screen control via Accessibility API and CGEvent - automates mouse, keyboard, screenshots, and window management. Use when user wants to control macOS desktop, automate UI interactions, click buttons, type text, take screenshots, or manage windows.
allowed-tools: Read, Write, Bash
---

# Mac Control Skill

Native macOS screen/keyboard/mouse control via CGEvent (CoreGraphics) and Accessibility API.

> **Requirement**: macOS with Accessibility permission granted.
> Enable at: System Settings → Privacy & Security → Accessibility

## Quick Start

```bash
# Screenshot (returns PNG path)
python3 scripts/mac-control.py screenshot --output /tmp/screen.png

# Click at coordinates
python3 scripts/mac-control.py click --x 500 --y 300

# Type text (supports Chinese via clipboard paste)
python3 scripts/mac-control.py type --text "Hello 你好"

# Get window info
bash scripts/mac-window.sh bounds "Feishu"

# Activate an app
bash scripts/mac-window.sh activate "Feishu"

# Calibrate coordinates
python3 scripts/mac-calibrate.py
```

All scripts are in `skills/mac-control/scripts/`. Use absolute paths when calling from outside the skill directory.

## Core Tools

### 1. Screenshot (`mac-control.py screenshot`)

```bash
python3 scripts/mac-control.py screenshot [--output PATH] [--region X,Y,W,H] [--cursor]
```

- Default output: `/tmp/mac-screenshot-{timestamp}.png`
- `--region`: Capture specific area (logical coordinates)
- `--cursor`: Include cursor in screenshot
- Returns: JSON `{"success": true, "path": "/tmp/...", "width": N, "height": N, "scaleFactor": N}`

### 2. Mouse Control (`mac-control.py click/move/drag`)

```bash
# Left click
python3 scripts/mac-control.py click --x 500 --y 300 [--double] [--right]

# Move mouse
python3 scripts/mac-control.py move --x 500 --y 300

# Drag
python3 scripts/mac-control.py drag --from-x 100 --from-y 100 --to-x 500 --to-y 300
```

All coordinates are **logical points** (not Retina pixels). Use `mac-calibrate.py` to verify.

### 3. Keyboard Input (`mac-control.py type/key`)

```bash
# Type text (auto-detects CJK → uses clipboard paste)
python3 scripts/mac-control.py type --text "Hello 世界"

# Press key combo
python3 scripts/mac-control.py key --key return
python3 scripts/mac-control.py key --key v --modifiers command
python3 scripts/mac-control.py key --key tab --modifiers command
```

**CJK Handling**: Non-ASCII text is automatically sent via clipboard paste (`pbcopy` + `Cmd+V`), bypassing IME issues. The original clipboard contents are saved and restored.

Available key names: `return`, `tab`, `space`, `delete`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `a`-`z`, `0`-`9`, `f1`-`f12`.

### 4. Window Management (`mac-window.sh`)

```bash
# Get window bounds
bash scripts/mac-window.sh bounds "Feishu"
# Returns: {"x":100,"y":50,"width":1200,"height":800,"scaleFactor":2}

# Activate (bring to front)
bash scripts/mac-window.sh activate "Feishu"

# List all windows
bash scripts/mac-window.sh list
```

### 5. Coordinate Calibration (`mac-calibrate.py`)

```bash
python3 scripts/mac-calibrate.py
```

Returns the current display's scale factor and verifies coordinate consistency between screenshot and CGEvent. Store the result for subsequent operations.

## Coordinate System

| Concept | Description |
|---------|-------------|
| **Logical points** | CGEvent operates in logical points (what the OS uses) |
| **Physical pixels** | Screenshot images are in physical pixels (Retina = 2x) |
| **Conversion** | `logical = physical / scaleFactor` |

When using screenshot analysis to determine click targets:
1. Get scale factor from `mac-calibrate.py`
2. Divide screenshot pixel coordinates by scale factor
3. Use the result as click coordinates

## Workflow: Screenshot → Analyze → Act → Verify

```
1. Activate target app     → mac-window.sh activate "App Name"
2. Get window bounds       → mac-window.sh bounds "App Name"
3. Take screenshot         → mac-control.py screenshot
4. Analyze screenshot      → (Claude reads image, identifies target)
5. Convert coordinates     → screenshot_px / scaleFactor = logical_pt
6. Click target            → mac-control.py click --x X --y Y
7. Verify                  → mac-control.py screenshot (compare)
```

## Error Handling

All scripts return JSON with `success` field:
```json
{"success": true, ...}
{"success": false, "error": "Description of what went wrong"}
```

Common errors:
- `"Accessibility permission denied"` → Grant permission in System Settings
- `"App not found: X"` → Check exact app name in `mac-window.sh list`
- `"Screenshot failed"` → Check disk space and /tmp permissions

## Limitations

- **macOS only**: Scripts use CoreGraphics and AppleScript, unavailable on Linux/Windows
- **Headless not supported**: Requires active GUI session (no SSH-only)
- **Permission required**: Accessibility API needs explicit user approval
- **Multi-monitor**: Coordinates span all displays; primary display starts at (0,0)
- **Electron apps**: CGEvent is more reliable than AX for click/typing on Electron apps (Feishu, VS Code, etc.)

## Technical Details

- Mouse/keyboard: CGEvent via Python ctypes (zero external dependencies)
- Screenshots: `screencapture` CLI (built into macOS)
- Window management: AppleScript via `osascript`
- Chinese input: Clipboard paste method (`pbcopy` + `Cmd+V`)
- No cliclick dependency — direct CGEvent calls are cleaner and more reliable

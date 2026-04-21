---
name: mac-control
description: macOS screen control and automation skill - controls mouse, keyboard, screenshots, and window management via CGEvent and Accessibility API. Use when user says keywords like "屏幕控制", "鼠标控制", "键盘输入", "截图", "Mac自动化", "screen control", "click", "type text", "screenshot", "mac control", "桌面自动化".
allowed-tools: [Bash, Read, Write]
---

# Mac Screen Control Skill

macOS native screen/keyboard/mouse control skill for desktop automation.

## Technical Rationale

Uses **CGEvent** (CoreGraphics) via Python ctypes for hardware-level input simulation:
- Zero external dependencies (uses system Python + ctypes)
- Works with all apps including Electron (unlike Accessibility API for input)
- Handles Retina display coordinate mapping automatically
- Supports CJK text input via clipboard paste method

## Prerequisites

> **Platform**: macOS only. This skill checks for macOS at runtime and will error on other platforms.

Required macOS permissions:
1. **System Settings → Privacy & Security → Accessibility** — grant to Terminal / your app
2. **System Settings → Privacy & Security → Screen Recording** — for screenshots

## API Reference

The main script is `scripts/mac_control.py`. All commands are invoked via:

```bash
python3 scripts/mac_control.py <command> [args...]
```

### Mouse Control

| Command | Args | Description |
|---------|------|-------------|
| `click` | `x y` | Left click at coordinates |
| `double_click` | `x y` | Double left click |
| `right_click` | `x y` | Right click at coordinates |
| `drag` | `x1 y1 x2 y2` | Drag from (x1,y1) to (x2,y1) |
| `move` | `x y` | Move mouse to coordinates |

### Keyboard Control

| Command | Args | Description |
|---------|------|-------------|
| `type_text` | `text` | Type text (supports CJK via clipboard) |
| `key` | `key [modifiers...]` | Press key with optional modifiers |

**Supported modifier keys**: `cmd`, `shift`, `alt`, `ctrl`

**Supported key names**: `return`, `tab`, `escape`, `delete`, `backspace`, `space`, `up`, `down`, `left`, `right`, `home`, `end`, `a`-`z`, `0`-`9`, `f1`-`f12`

### Screenshots

| Command | Args | Description |
|---------|------|-------------|
| `screenshot` | `[output_path]` | Capture full screen (default: `/tmp/screenshot.png`) |
| `screenshot_region` | `x y w h [output_path]` | Capture screen region |

### Window Management

| Command | Args | Description |
|---------|------|-------------|
| `get_frontmost_app` | | Get name and window bounds of frontmost app |
| `activate_app` | `app_name` | Bring app to foreground |
| `get_window_bounds` | `app_name` | Get {x, y, width, height} of app's main window |
| `list_windows` | | List all visible windows with positions |

### Coordinate Utilities

| Command | Args | Description |
|---------|------|-------------|
| `get_scale_factor` | | Get Retina backing scale factor (1x or 2x) |
| `screen_to_logical` | `x y` | Convert screen pixel coords to logical (point) coords |
| `logical_to_screen` | `x y` | Convert logical (point) coords to screen pixel coords |
| `get_mouse_position` | | Get current mouse position in logical coords |

## Workflow

### Basic Click Flow
1. `screenshot` — capture current screen state
2. Analyze screenshot to find target element coordinates
3. `get_scale_factor` — check if Retina adjustment needed
4. `click x y` — click the target element

### Text Input Flow
1. `click x y` — click into the target text field
2. `type_text "your text here"` — type text (CJK supported via clipboard)

### Cross-App Flow
1. `activate_app "Feishu"` — bring target app to front
2. `screenshot` — see current state
3. Perform actions (click, type, etc.)

## Coordinate System

> **Important**: macOS uses two coordinate systems:
> - **Logical points**: Used by CGEvent (what you pass to click/type)
> - **Screen pixels**: What screenshots contain
>
> On Retina displays, `pixel = logical * backingScaleFactor`.
> The `get_scale_factor` command tells you the current factor.
>
> **Rule**: When you get coordinates from a screenshot, divide by scale factor
> before passing to click commands.

## Examples

### Example 1: Click a button at screenshot coordinates

```
# Step 1: Take screenshot
python3 scripts/mac_control.py screenshot /tmp/screen.png

# Step 2: User finds button at pixel (400, 300) in screenshot
# Step 3: Get scale factor
python3 scripts/mac_control.py get_scale_factor
# Output: 2.0

# Step 4: Convert and click (pixel / scale = logical)
python3 scripts/mac_control.py click 200 150
```

### Example 2: Type Chinese text

```
# Click into a text field first
python3 scripts/mac_control.py click 200 150

# Type Chinese text (uses clipboard paste method)
python3 scripts/mac_control.py type_text "你好世界"
```

### Example 3: Activate app and take action

```
# Bring Feishu to front
python3 scripts/mac_control.py activate_app "Lark"

# Wait a moment, then screenshot
python3 scripts/mac_control.py screenshot /tmp/feishu.png

# Find and click search box, then type
python3 scripts/mac_control.py click 300 50
python3 scripts/mac_control.py type_text "搜索内容"
```

### Example 4: Use keyboard shortcuts

```
# Copy (Cmd+C)
python3 scripts/mac_control.py key c cmd

# Paste (Cmd+V)
python3 scripts/mac_control.py key v cmd

# Switch app (Cmd+Tab)
python3 scripts/mac_control.py key tab cmd
```

## Error Handling

- **Platform check**: Script exits with code 1 and message on non-macOS
- **Permission errors**: CGEvent returns null if accessibility not granted
- **App not found**: `activate_app` returns error JSON if app doesn't exist
- **Invalid coordinates**: Commands validate coordinate ranges

## Security Considerations

- CGEvent generates hardware-level events — all apps treat them as real input
- Only use on trusted desktops with user awareness
- The skill cannot bypass login screens or security dialogs
- All actions are logged to console for audit

## DO NOT

- Do NOT use for malicious automation (spamming, credential harvesting)
- Do NOT attempt to bypass security prompts or authentication
- Do NOT run unattended on shared machines
- Do NOT use on headless/remote servers without GUI access

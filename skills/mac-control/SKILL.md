---
name: mac-control
description: macOS screen control and desktop automation via CGEvent. Use when user wants to control Mac desktop, click UI elements, type text, take screenshots, or automate desktop applications. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "screen control", "mac automation", "click UI".
allowed-tools: Read, Write, Bash, mcp__4_5v_mcp__analyze_image
---

# Mac Screen Control Agent

You are a macOS desktop automation specialist. You control the Mac desktop using the `macctl` CLI tool, which wraps CoreGraphics CGEvent for hardware-level mouse/keyboard control.

## Tool: macctl

The `macctl` script is at `skills/mac-control/scripts/macctl.py`. All commands return JSON.

### Prerequisites

- **macOS only** — this skill requires macOS with CoreGraphics framework
- **Accessibility permission** — System Settings → Privacy & Security → Accessibility → grant to terminal/IDE
- **No dependencies** — uses Python 3 ctypes (built-in) + macOS CLI tools (screencapture, osascript, pbcopy)

### Available Commands

```bash
SCRIPT="skills/mac-control/scripts/macctl.py"

# Screenshot
python3 $SCRIPT screenshot [output_path]

# Mouse control (coordinates in logical points, NOT pixels)
python3 $SCRIPT click <x> <y>
python3 $SCRIPT double-click <x> <y>
python3 $SCRIPT right-click <x> <y>
python3 $SCRIPT move <x> <y>
python3 $SCRIPT drag <x1> <y1> <x2> <y2>
python3 $SCRIPT mouse-pos

# Keyboard (supports CJK via clipboard paste method)
python3 $SCRIPT type "Hello 你好"
python3 $SCRIPT key <key> [cmd|shift|ctrl|alt ...]
# Examples:
python3 $SCRIPT key return
python3 $SCRIPT key v cmd        # Cmd+V paste
python3 $SCRIPT key a cmd        # Cmd+A select all
python3 $SCRIPT key tab
python3 $SCRIPT key s cmd        # Cmd+S save

# Window management
python3 $SCRIPT window "Feishu"              # Get window bounds
python3 $SCRIPT activate "Feishu"            # Bring app to front

# Calibration
python3 $SCRIPT calibrate    # Show Retina scale factor + screen bounds
python3 $SCRIPT scale        # Get Retina scale factor only
```

## Coordinate System

> **Critical**: macOS has two coordinate spaces:
> - **Logical points** — used by CGEvent (what macctl uses)
> - **Pixel coordinates** — used by screenshots (Retina = 2x)
>
> **Conversion**: `logical_point = pixel_coord / scale_factor`
>
> Use `macctl calibrate` to determine the current scale factor.

### Finding Coordinates

1. Take a screenshot: `python3 $SCRIPT screenshot`
2. Read the screenshot image to identify target element position (in pixels)
3. Divide pixel coordinates by scale factor to get logical points
4. Use logical points with click/type commands

## Workflow Pattern

### Basic UI Interaction

```
1. calibrate  →  get scale factor
2. screenshot →  capture current screen
3. analyze    →  find target coordinates (pixel)
4. convert    →  pixel / scale = logical point
5. click      →  macctl click <x> <y>
6. type       →  macctl type "text"
7. verify     →  screenshot again to confirm result
```

### Cross-Application Example

```
1. activate "Feishu"         →  bring Feishu to front
2. window "Feishu"           →  get window bounds
3. screenshot                →  see current state
4. click <x> <y>             →  click search box
5. type "group name"         →  search for group
6. key return                →  confirm
7. screenshot                →  verify navigation
```

## Key Reference

Common virtual key names for `macctl key`:

| Category | Keys |
|----------|------|
| **Modifiers** | `cmd`, `shift`, `ctrl`, `alt`/`option`, `capslock` |
| **Special** | `return`/`enter`, `tab`, `space`, `escape`/`esc`, `delete`/`backspace` |
| **Navigation** | `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown` |
| **Function** | `f1`–`f12` |
| **Letters** | `a`–`z` |
| **Numbers** | `0`–`9` |

## Best Practices

### Reliability
- Always `screenshot` before and after actions to verify state
- Use `calibrate` once at session start to cache scale factor
- Add small delays (0.1–0.3s) between actions that trigger UI updates
- Use `window` to confirm target app is visible before interacting

### Text Input
- `macctl type` uses clipboard paste — the most reliable method for CJK text
- For special key combinations (shortcuts), use `macctl key <key> <modifiers>`
- Clipboard is preserved — `type` saves and restores clipboard contents

### Error Handling
- If `macctl` returns `{"ok": false, ...}`, read the `error` field
- Common errors:
  - Accessibility permission not granted → guide user to System Settings
  - App not found → verify app name with `activate`
  - Window not found → app may be minimized or hidden

## Limitations

- **macOS only** — will not work on Linux or Windows
- **Requires GUI session** — cannot be used in headless/SSH environments
- **Accessibility permission** — must be granted to the running process
- **No element tree** — Phase 3 (AXUIElement tree walking) not yet implemented
- **Single monitor** — multi-monitor coordinate offsets not yet handled

## Implementation Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1: Basic Tools | ✅ Done | Mouse, keyboard, screenshot, window management |
| Phase 2: Text Input | ✅ Done | Clipboard paste for CJK, modifier key combos |
| Phase 3: UI Interaction | ❌ Todo | Accessibility element tree, visual matching |
| Phase 4: Agent Integration | ✅ Done | Integrated as Skill with macctl CLI |

## DO NOT

- Do NOT use on servers without physical display (headless)
- Do NOT attempt to bypass macOS security prompts — guide user to grant permissions
- Do NOT send rapid-fire events — add reasonable delays between actions
- Do NOT handle login/password screens — security risk

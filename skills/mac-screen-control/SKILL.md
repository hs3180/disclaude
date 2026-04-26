---
name: mac-screen-control
description: Mac screen/keyboard/mouse control via CGEvent + Accessibility API. Use for automating desktop apps (Feishu, browsers, Electron) when browser automation fails. Supports Chinese text input, Retina coordinate handling, and UI element discovery.
allowed-tools: [Bash, Read, Write, Glob, Grep]
---

# Mac Screen Control

Control macOS desktop applications through hardware-level input injection using **CGEvent** (mouse/keyboard) and **Accessibility API** (UI element discovery).

> **When to use**: When browser automation (CDP, Playwright) can't reach native UI elements, file dialogs, Electron apps, or when you need to control non-browser applications like Feishu.

## Prerequisites

1. **macOS** (this skill does nothing on Linux/Windows — gracefully exits)
2. **Accessibility permissions**: System Settings → Privacy & Security → Accessibility → add Terminal / iTerm / your agent runtime
3. **Python 3** (stdlib only — zero pip dependencies)

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Mouse control | CGEvent via Python ctypes | Hardware-level click/drag/move |
| Keyboard input | Clipboard + Cmd+V (pbcopy) | Reliable CJK/Unicode text input |
| Key press | CGEvent via Python ctypes | Individual key presses + modifiers |
| Screenshots | `/usr/sbin/screencapture` | Built-in macOS screenshot |
| Window info | `osascript` + System Events | Window bounds, app activation |
| UI elements | Accessibility API via osascript | Find buttons, text fields, menus |
| Coordinate fix | Auto-detect Retina scaling | Logical ↔ physical pixel conversion |

## Quick Start

```bash
# Take a screenshot
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/screen.png

# Get window bounds for an app
python3 skills/mac-screen-control/mac_control.py window "Feishu"

# Click at screen coordinates
python3 skills/mac-screen-control/mac_control.py click 500 300

# Type Chinese/Unicode text (clipboard-based, bypasses IME)
python3 skills/mac-screen-control/mac_control.py type "你好世界"

# Find a UI element by name
python3 skills/mac-screen-control/mac_control.py find-element "Feishu" "Send"

# Calibrate Retina scaling
python3 skills/mac-screen-control/mac_control.py calibrate
```

## CLI Reference

| Command | Args | Description |
|---------|------|-------------|
| `click` | `x y` | Left-click at (x, y) |
| `doubleclick` | `x y` | Double-click at (x, y) |
| `rightclick` | `x y` | Right-click at (x, y) |
| `move` | `x y` | Move cursor to (x, y) |
| `drag` | `x1 y1 x2 y2` | Drag from (x1,y1) to (x2,y2) |
| `type` | `"text"` | Type text via clipboard (supports CJK/emoji) |
| `key` | `"key" [modifiers]` | Press key with optional modifiers (cmd,shift,alt,ctrl) |
| `screenshot` | `[path]` | Capture screenshot (default: /tmp/screen.png) |
| `window` | `"App Name"` | Get front window position and size |
| `windows` | `"App Name"` | List all windows with titles |
| `activate` | `"App Name"` | Bring app to foreground |
| `find-element` | `"App" "name"` | Find UI element by accessibility label |
| `calibrate` | — | Detect and report Retina scaling factor |
| `cursor` | — | Get current cursor position |

## Core Workflow: Screenshot → Analyze → Click → Verify

This is the **recommended pattern** for all interactions:

```bash
# 1. Screenshot current state
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/before.png

# 2. Read the screenshot to find target coordinates
#    (Use Read tool on /tmp/before.png — it's a visual image)

# 3. Click at the identified coordinates
python3 skills/mac-screen-control/mac_control.py click 500 300

# 4. Wait for UI to respond
sleep 1

# 5. Verify by taking another screenshot
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/after.png
```

## Coordinate System

### Understanding Retina vs Logical

macOS uses **logical points** (not physical pixels) for all coordinate APIs:
- **CGEvent** coordinates: always in logical points
- **Screenshot** dimensions: in physical pixels (2x on Retina)
- **Conversion**: `logical = physical / scaleFactor`

The `calibrate` command auto-detects your scaling factor:

```bash
python3 skills/mac-screen-control/mac_control.py calibrate
# Output: scaleFactor=2, logical=1440x900, physical=2880x1800
```

### When analyzing screenshots:

1. If the screenshot image is **2880×1800** but `calibrate` says logical resolution is **1440×900**
2. Divide screenshot pixel coordinates by **2** to get CGEvent coordinates
3. The `click` command handles this automatically if you pass `--from-screenshot` flag

```bash
# Click at screenshot pixel coordinates (auto-scales for Retina)
python3 skills/mac-screen-control/mac_control.py click --from-screenshot 1200 600
# Equivalent to: click 600 300 (on 2x Retina)
```

## Chinese / Unicode Text Input

The biggest challenge in macOS automation is **Chinese text input** — system IME intercepts keyboard events and produces garbage output.

**Solution**: Clipboard-based input bypasses IME entirely:

```bash
# Type Chinese text — works reliably every time
python3 skills/mac-screen-control/mac_control.py type "你好世界 Hello 🎉"
```

**How it works internally**:
1. Save current clipboard contents
2. `echo -n "text" | pbcopy` — copy text to clipboard
3. CGEvent: Cmd+V — paste into focused field
4. Restore original clipboard contents

### Click + Type Pattern

```bash
# 1. Click on text field
python3 skills/mac-screen-control/mac_control.py click 500 300
sleep 0.3

# 2. Select all existing text (optional)
python3 skills/mac-screen-control/mac_control.py key "a" "cmd"
sleep 0.1

# 3. Type new text
python3 skills/mac-screen-control/mac_control.py type "替换的中文内容"
```

## Window Management

```bash
# Get front window position
python3 skills/mac-screen-control/mac_control.py window "Feishu"
# → Feishu: x=0, y=38, w=1440, h=860

# List all windows
python3 skills/mac-screen-control/mac_control.py windows "Google Chrome"
# → [0] x=0, y=38, w=1440, h=860 "GitHub"
# → [1] x=100, y=100, w=800, h=600 "Gmail"

# Activate (bring to front)
python3 skills/mac-screen-control/mac_control.py activate "Feishu"
```

### Relative Coordinate Calculation

```bash
# Get window bounds → calculate element position
python3 skills/mac-screen-control/mac_control.py window "Feishu"
# Feishu: x=100, y=38, w=1200, h=800

# If you know the "Send" button is at relative position (1100, 750) within the window:
# screen_x = window_x + relative_x = 100 + 1100 = 1200
# screen_y = window_y + relative_y = 38 + 750 = 788

python3 skills/mac-screen-control/mac_control.py click 1200 788
```

## UI Element Discovery (Accessibility API)

Find UI elements by their accessibility label:

```bash
# Find element named "Send" in Feishu
python3 skills/mac-screen-control/mac_control.py find-element "Feishu" "Send"
# → Found: "Send" button at (1200, 788) size (80, 30)
```

### Limitations

- Accessibility API may not find elements in **Electron apps** unless Chromium accessibility is enabled
- For Electron apps, prefer **screenshot + coordinate** approach
- Some apps have non-standard accessibility trees

## Common Patterns

### Pattern 1: Open Feishu → Navigate to Chat → Send Message

```bash
# Activate Feishu
python3 skills/mac-screen-control/mac_control.py activate "Feishu"
sleep 1

# Screenshot to see current state
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/feishu.png

# Click on search field (identified from screenshot)
python3 skills/mac-screen-control/mac_control.py click 400 50
sleep 0.5

# Type contact/group name
python3 skills/mac-screen-control/mac_control.py type "目标群聊名称"
sleep 1

# Screenshot search results
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/search.png

# Click on the first result
python3 skills/mac-screen-control/mac_control.py click 400 200
sleep 1

# Click on message input field
python3 skills/mac-screen-control/mac_control.py click 600 800
sleep 0.3

# Type message
python3 skills/mac-screen-control/mac_control.py type "自动发送的消息"

# Press Enter to send
python3 skills/mac-screen-control/mac_control.py key "return"
```

### Pattern 2: File Dialog Navigation

```bash
# Click triggers file dialog
python3 skills/mac-screen-control/mac_control.py click 750 400
sleep 1

# Open "Go to Folder" (Cmd+Shift+G)
python3 skills/mac-screen-control/mac_control.py key "g" "cmd,shift"
sleep 1

# Type file path
python3 skills/mac-screen-control/mac_control.py type "/path/to/file.png"
sleep 0.5

# Press Enter to navigate
python3 skills/mac-screen-control/mac_control.py key "return"
sleep 1

# Press Enter to confirm selection
python3 skills/mac-screen-control/mac_control.py key "return"
```

### Pattern 3: Keyboard Navigation (Fallback)

When mouse clicks are blocked by security (Google OAuth, protected pages):

```bash
# Tab to navigate between elements
python3 skills/mac-screen-control/mac_control.py key "tab"
sleep 0.15
python3 skills/mac-screen-control/mac_control.py key "tab"
sleep 0.15
python3 skills/mac-screen-control/mac_control.py key "tab"
sleep 0.15

# Enter to activate focused element
python3 skills/mac-screen-control/mac_control.py key "return"
```

## Integration with Agent Workflow

This skill is designed to work within the disclaude agent framework:

1. **Agent receives request** requiring desktop interaction
2. **Agent invokes this skill** to control the Mac
3. **Skill executes commands** and returns results
4. **Agent verifies** via screenshots and adapts

### Error Recovery

```bash
# If click didn't work, try:
# 1. Verify app is active
python3 skills/mac-screen-control/mac_control.py activate "AppName"
sleep 0.5

# 2. Re-measure coordinates
python3 skills/mac-screen-control/mac_control.py screenshot /tmp/retry.png

# 3. Try keyboard navigation as fallback
python3 skills/mac-screen-control/mac_control.py key "tab"
```

## Platform Detection

The script automatically detects the platform:
- **macOS**: Full functionality
- **Linux/Windows**: Prints error and exits with code 1
- **No display**: Prints error and exits with code 1

## Safety

- **App name sanitization**: App names passed to osascript are validated (no injection)
- **Coordinate bounds checking**: Coordinates are validated before sending events
- **Clipboard preservation**: Original clipboard contents are saved and restored after `type`
- **No data exfiltration**: This skill only sends input events, never reads screen content beyond screenshots

## DO NOT

- Do NOT use this skill on systems without explicit user consent
- Do NOT automate login pages that block synthetic events (use keyboard fallback)
- Do NOT perform rapid-fire clicks without delays (causes system instability)
- Do NOT attempt to bypass security dialogs or permission prompts
- Do NOT store screenshot images containing sensitive data

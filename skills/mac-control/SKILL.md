---
name: mac-control
description: macOS desktop automation - control mouse, keyboard, take screenshots, and interact with desktop applications via Accessibility API. Use when user wants to automate macOS desktop tasks, control UI elements, capture screens, or interact with native apps like Feishu.
allowed-tools: Bash, Read, Write, mcp__4_5v_mcp__analyze_image
---

# Mac Control — macOS Desktop Automation Skill

You are a macOS desktop automation agent. You control the mouse, keyboard, and interact with desktop applications using native macOS APIs.

> **Platform**: macOS only. Requires Accessibility permission (System Settings → Privacy & Security → Accessibility).

## Technical Rationale

This skill exists to enable AI agents to:
1. **Interact with desktop apps** — click buttons, type text, navigate UIs
2. **Capture and analyze screens** — take screenshots and extract information
3. **Automate repetitive tasks** — batch operations across applications
4. **Handle Chinese text input** — clipboard-based CJK input that bypasses IME issues

## Prerequisites

### 1. Install pyobjc (required)
```bash
pip3 install pyobjc-framework-Quartz
```

### 2. Grant Accessibility Permission
- Open **System Settings → Privacy & Security → Accessibility**
- Add your terminal/IDE to the allowed list
- Restart the terminal after granting

### 3. Verify Setup
```bash
python3 scripts/mac_control.py calibrate
```
Should return JSON with screen info (scale factor, dimensions).

## Core Workflow

The typical automation cycle is:

```
1. Activate target app → 2. Get window bounds → 3. Screenshot → 4. Analyze → 5. Interact → 6. Verify
```

### Step 1: Activate Application
```bash
python3 scripts/mac_control.py activate "Feishu"
```

### Step 2: Get Window Bounds
```bash
python3 scripts/mac_control.py window "Feishu"
```
Returns window position and size. Use these coordinates as reference for relative positioning.

### Step 3: Capture Screenshot
```bash
# Full screen
python3 scripts/mac_control.py screenshot --output /tmp/screen.png

# Specific region
python3 scripts/mac_control.py screenshot --output /tmp/region.png --region 100,200,500,400
```

### Step 4: Analyze Screenshot
Use `mcp__4_5v_mcp__analyze_image` with the screenshot to:
- Identify UI elements and their positions
- Read text on screen
- Determine what to click or type

### Step 5: Interact
```bash
# Click (coordinates are in screenshot pixel space)
python3 scripts/mac_control.py click 500 300
python3 scripts/mac_control.py click 500 300 --button right
python3 scripts/mac_control.py click 500 300 --double

# Type text (supports CJK via clipboard)
python3 scripts/mac_control.py type "Hello 你好世界"
python3 scripts/mac_control.py type "ASCII only" --no-clipboard

# Press keys
python3 scripts/mac_control.py key return
python3 scripts/mac_control.py key tab
python3 scripts/mac_control.py key v --modifiers cmd
python3 scripts/mac_control.py key f --modifiers cmd,shift

# Drag
python3 scripts/mac_control.py drag 100 200 400 500 --duration 0.3

# Move cursor (without clicking)
python3 scripts/mac_control.py move 500 300
```

### Step 6: Verify
Take another screenshot and analyze to confirm the action succeeded.

## Coordinate System

**Important**: Coordinates are in **screenshot pixel space**, not logical points.

- Screenshots are at full pixel resolution (e.g., 2880×1800 on Retina)
- CGEvent uses logical points (e.g., 1440×900 on Retina)
- The script **automatically converts** pixel → point coordinates
- So always use coordinates from your screenshot analysis directly

To check the scale factor:
```bash
python3 scripts/mac_control.py calibrate
```

## UI Element Discovery (Accessibility API)

Find UI elements by role or title:
```bash
# Find all buttons in Feishu
python3 scripts/mac_control.py find-element "Feishu" --role AXButton

# Find elements with specific text
python3 scripts/mac_control.py find-element "Feishu" --title "Send"
```

**Note**: Accessibility API support varies by app. Electron apps may have limited support.

## Common Patterns

### Pattern 1: Click a Button
```bash
# 1. Screenshot
python3 scripts/mac_control.py screenshot -o /tmp/screen.png
# 2. Analyze image to find button coordinates
# 3. Click
python3 scripts/mac_control.py click <X> <Y>
```

### Pattern 2: Type in a Text Field
```bash
# 1. Click on the text field
python3 scripts/mac_control.py click <X> <Y>
# 2. Clear existing text (Cmd+A then Delete)
python3 scripts/mac_control.py key a --modifiers cmd
python3 scripts/mac_control.py key delete
# 3. Type new text
python3 scripts/mac_control.py type "New content"
```

### Pattern 3: Navigate to a Chat
```bash
# 1. Activate Feishu
python3 scripts/mac_control.py activate "Feishu"
# 2. Use Cmd+K to open search
python3 scripts/mac_control.py key k --modifiers cmd
# 3. Type chat name
python3 scripts/mac_control.py type "Team Chat"
# 4. Press Enter to select
python3 scripts/mac_control.py key return
```

### Pattern 4: Read Screen Content
```bash
# 1. Screenshot
python3 scripts/mac_control.py screenshot -o /tmp/screen.png
# 2. Analyze with vision model
# Use the analyze_image tool to extract text and UI state
```

## Key Reference

| Key Name | Description |
|----------|-------------|
| `return` / `enter` | Enter key |
| `tab` | Tab key |
| `space` | Space bar |
| `delete` / `backspace` | Backspace |
| `escape` / `esc` | Escape |
| `up`, `down`, `left`, `right` | Arrow keys |
| `home`, `end` | Home/End |
| `pageup`, `pagedown` | Page Up/Down |
| `f1`–`f12` | Function keys |
| `a`–`z` | Letter keys |

| Modifier | Key |
|----------|-----|
| `cmd` | Command (⌘) |
| `shift` | Shift (⇧) |
| `ctrl` | Control (⌃) |
| `alt` / `option` | Option (⌥) |

## Limitations & Troubleshooting

### Electron Apps
- CGEvent (hardware-level) clicks are more reliable than Accessibility API for Electron apps
- Accessibility tree may be incomplete for some Electron apps
- **Workaround**: Use screenshot + coordinate-based clicking

### Chinese Input
- Always use the default clipboard method (`type "中文"`) for CJK text
- The `--no-clipboard` flag only supports ASCII characters
- Clipboard contents are automatically saved and restored

### Permissions
- If clicks don't register, check Accessibility permissions
- If screenshots fail, check Screen Recording permissions
- Restart the terminal after granting permissions

### Retina Displays
- Coordinate conversion is automatic
- Screenshot resolution is at full pixel density
- Use `calibrate` to verify scale factor if clicks seem off

### Multi-Monitor
- Coordinates span the full virtual display space
- Use `calibrate` to see all screen layouts
- Screenshot captures the main display by default

## Safety Notes

- ⚠️ CGEvent generates hardware-level events that no app can distinguish from real input
- Always verify actions with a screenshot before proceeding
- Use `--region` to limit screenshots when possible
- Consider adding delays between rapid operations
- The clipboard is restored after each `type` command, but brief clipboard changes may be visible

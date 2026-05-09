---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Mac Screen Control

Control macOS desktop applications via Accessibility API and CGEvent. This skill provides mouse, keyboard, screenshot, and window management capabilities for automating UI interactions.

> **Platform**: macOS only. All operations require Accessibility permission granted in System Settings > Privacy & Security > Accessibility.

## Single Responsibility

- Take screenshots and read screen content
- Click, double-click, right-click, and drag at coordinates
- Type text including Chinese via clipboard injection
- Press keys with modifiers
- Activate and manage application windows
- Calibrate Retina display coordinates

## Prerequisites

1. **macOS** with Accessibility permission granted
2. **Python 3** (system Python works)
3. No external dependencies (uses only ctypes, subprocess, stdlib)

## CLI Interface

All operations use `mac_control.py`:

```bash
python3 skills/mac-screen-control/scripts/mac_control.py <command> [args...]
```

### Commands

#### Screenshot

```bash
# Full screen screenshot
python3 skills/mac-screen-control/scripts/mac_control.py screenshot --output /tmp/screen.png

# Region screenshot (x, y, width, height)
python3 skills/mac-screen-control/scripts/mac_control.py screenshot --region 100,200,800,600 --output /tmp/region.png
```

#### Mouse Control

```bash
# Left click
python3 skills/mac-screen-control/scripts/mac_control.py click 500 300

# Right click
python3 skills/mac-screen-control/scripts/mac_control.py click 500 300 --button right

# Double click
python3 skills/mac-screen-control/scripts/mac_control.py click 500 300 --count 2

# Move mouse
python3 skills/mac-screen-control/scripts/mac_control.py move 500 300

# Drag from one point to another
python3 skills/mac-screen-control/scripts/mac_control.py drag 100 100 500 300
```

#### Text Input

```bash
# Type text (Chinese supported via clipboard)
python3 skills/mac-screen-control/scripts/mac_control.py type "Hello 你好世界"

# Type with delay between keystrokes (ms)
python3 skills/mac-screen-control/scripts/mac_control.py type "some text" --delay 50
```

#### Key Press

```bash
# Press a key
python3 skills/mac-screen-control/scripts/mac_control.py key return

# Key with modifiers
python3 skills/mac-screen-control/scripts/mac_control.py key v --modifiers cmd
python3 skills/mac-screen-control/scripts/mac_control.py key c --modifiers cmd,shift
```

**Supported key names**: `return`, `tab`, `space`, `delete`, `escape`, `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`, `f1`-`f12`, `a`-`z`, `0`-`9`

#### Window Management

```bash
# Activate an application (bring to front)
python3 skills/mac-screen-control/scripts/mac_control.py activate "Feishu"

# Get window bounds
python3 skills/mac-screen-control/scripts/mac_control.py window "Feishu"
```

#### Coordinate Calibration

```bash
# Detect Retina scale factor and display calibration info
python3 skills/mac-screen-control/scripts/mac_control.py calibrate
```

## Typical Workflows

### Workflow 1: Screenshot -> Analyze -> Click

```
1. Take screenshot: mac_control.py screenshot --output /tmp/screen.png
2. Read screenshot with vision (Read tool on the PNG file)
3. Identify target element coordinates
4. Click at coordinates: mac_control.py click <x> <y>
```

### Workflow 2: Find and Interact with App

```
1. Activate app: mac_control.py activate "Feishu"
2. Get window position: mac_control.py window "Feishu"
3. Take screenshot for visual analysis
4. Click/type to interact with UI elements
```

### Workflow 3: Type Chinese Text

```
1. Click on target text field
2. Type text: mac_control.py type "中文内容"
   (Uses clipboard injection: pbcopy + Cmd+V)
```

## Coordinate System

- Coordinates are in **logical points** (not pixels)
- On Retina displays, screenshot pixels = logical points * backingScaleFactor (typically 2x)
- If you get pixel coordinates from a screenshot, divide by scale factor before clicking
- Use `calibrate` command to detect the current scale factor

## Safety Notes

- **Always verify coordinates** before clicking, especially for destructive actions
- **Save and restore clipboard** when using type command (clipboard content is overwritten)
- **Add delays** between rapid operations to allow UI to respond
- CGEvent generates hardware-level events; all apps treat them as real input

## DO NOT

- Do NOT use on non-macOS systems
- Do NOT rapidly repeat clicks (may trigger system event protection)
- Do NOT type extremely long text in a single call (break into chunks)
- Do NOT attempt to bypass authentication dialogs

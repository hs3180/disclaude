---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: Read, Write, Bash
---

# Mac Screen Control

You are a macOS desktop automation specialist. You control the user's Mac screen by executing bash commands that call the bundled Python CGEvent helper and AppleScript.

> **Important**: This skill only works on macOS with Accessibility permission granted. Verify the environment before proceeding.

## Single Responsibility

- ✅ Take screenshots and analyze UI elements
- ✅ Click, double-click, right-click at coordinates
- ✅ Type text including Chinese/CJK via clipboard paste
- ✅ Press keys with modifiers (Cmd, Shift, Alt, Ctrl)
- ✅ Drag elements between positions
- ✅ Manage windows (list, activate, get bounds)
- ✅ Handle Retina display coordinate conversion
- ❌ Cannot control iOS/iPadOS devices
- ❌ Cannot bypass macOS security prompts
- ❌ Cannot operate on headless/remote Linux servers

## Context Variables

Extract from the system message:
- **Chat ID**: Look for `Chat ID: oc_xxx` or `chatId`
- **Message ID**: Look for `Message ID: msg_xxx` or `messageId`

## Prerequisites Check

Before any automation, run this check:

```bash
# 1. Verify macOS
uname -s

# 2. Verify Python3 available
python3 --version

# 3. Get scale factor for coordinate conversion
SCRIPT_DIR="$(dirname "$(find . -path '*/mac-screen-control/scripts/mac_control.py' -print -quit 2>/dev/null || echo '.')")"
python3 "${SCRIPT_DIR:-.}/mac_control.py" scale
```

If not on macOS, inform the user this skill requires macOS.

## Coordinate System

**Retina displays**: CGEvent coordinates are in **logical points** (not pixels). Screenshots are in **pixels**.

```
CGEvent_coords = screenshot_pixel_coords / scale_factor
```

Example: If scale_factor = 2.0 and you see a button at pixel (400, 300):
- Click at CGEvent coordinates: (200, 150)

Always get the scale factor first with `python3 mac_control.py scale`.

## Workflow

### Step 1: Screenshot — See the Screen

```bash
# Take full screenshot
python3 SKILL_DIR/scripts/mac_control.py screenshot --output /tmp/screen.png

# Take region screenshot
python3 SKILL_DIR/scripts/mac_control.py screenshot --output /tmp/region.png --region 100,200,800,600
```

Then use the Read tool to view the screenshot image and identify target elements.

### Step 2: Analyze — Identify Coordinates

After reading the screenshot:
1. Identify the target UI element (button, input field, menu item)
2. Note its **pixel coordinates** (center of the element)
3. Convert to CGEvent coordinates: `pixel_x / scale_factor`, `pixel_y / scale_factor`

### Step 3: Act — Perform the Operation

#### Mouse Operations

```bash
# Left click at logical coordinates
python3 SKILL_DIR/scripts/mac_control.py click 200 150

# Right click
python3 SKILL_DIR/scripts/mac_control.py click 200 150 --button right

# Double click
python3 SKILL_DIR/scripts/mac_control.py click 200 150 --double

# Move mouse (no click)
python3 SKILL_DIR/scripts/mac_control.py move 200 150

# Drag from A to B (300ms default duration)
python3 SKILL_DIR/scripts/mac_control.py drag 100 100 400 300 --duration 500
```

#### Text Input (supports Chinese/CJK/emoji)

```bash
# Type text — uses clipboard paste internally, handles any Unicode
python3 SKILL_DIR/scripts/mac_control.py type "你好世界 Hello World 🌍"
```

The clipboard paste method is the most reliable for CJK input. The script automatically saves and restores the clipboard contents.

#### Key Presses

```bash
# Press single key
python3 SKILL_DIR/scripts/mac_control.py key RETURN

# Key with modifier
python3 SKILL_DIR/scripts/mac_control.py key A --modifier CMD     # Cmd+A (Select All)
python3 SKILL_DIR/scripts/mac_control.py key C --modifier CMD     # Cmd+C (Copy)
python3 SKILL_DIR/scripts/mac_control.py key V --modifier CMD     # Cmd+V (Paste)
python3 SKILL_DIR/scripts/mac_control.py key W --modifier CMD     # Cmd+W (Close)
python3 SKILL_DIR/scripts/mac_control.py key Q --modifier CMD     # Cmd+Q (Quit)
python3 SKILL_DIR/scripts/mac_control.py key TAB                  # Tab key
python3 SKILL_DIR/scripts/mac_control.py key S --modifier CMD,SHIFT  # Cmd+Shift+S

# Available keys: RETURN, TAB, SPACE, DELETE, ESCAPE, CMD, SHIFT, ALT, CTRL,
# UP, DOWN, LEFT, RIGHT, F1-F12, HOME, END, PAGEUP, PAGEDOWN
```

#### Window Management

```bash
# Activate (bring to front) an app
python3 SKILL_DIR/scripts/mac_control.py activate "Feishu"
python3 SKILL_DIR/scripts/mac_control.py activate "Google Chrome"

# List all visible windows
python3 SKILL_DIR/scripts/mac_control.py windows

# List windows of a specific app
python3 SKILL_DIR/scripts/mac_control.py windows --app "Feishu"
```

### Step 4: Verify — Screenshot After Action

Always take another screenshot after the action to verify the result:

```bash
python3 SKILL_DIR/scripts/mac_control.py screenshot --output /tmp/verify.png
```

Read the verification screenshot to confirm the action succeeded.

## Complete Automation Pattern

The standard loop for any desktop automation task:

```
1. activate TARGET_APP        → Bring app to front
2. screenshot                 → See current state
3. Read screenshot            → Identify target elements
4. click / type / key         → Perform action
5. screenshot                 → Capture result
6. Read screenshot            → Verify outcome
7. Repeat 2-6 if needed       → Continue automation
```

### Example: Send a message in Feishu

```bash
# 1. Activate Feishu
python3 SKILL_DIR/scripts/mac_control.py activate "Feishu"

# 2. Screenshot to find the input box
python3 SKILL_DIR/scripts/mac_control.py screenshot --output /tmp/feishu.png

# 3. Read screenshot, identify input box at pixel (600, 800)
#    With scale_factor=2: CGEvent coords = (300, 400)

# 4. Click input box
python3 SKILL_DIR/scripts/mac_control.py click 300 400

# 5. Type message (supports Chinese)
python3 SKILL_DIR/scripts/mac_control.py type "你好，这是一条测试消息"

# 6. Press Enter to send
python3 SKILL_DIR/scripts/mac_control.py key RETURN

# 7. Verify
python3 SKILL_DIR/scripts/mac_control.py screenshot --output /tmp/feishu_verify.png
```

## SKILL_DIR Resolution

The helper script is located at `SKILL_DIR/scripts/mac_control.py`. To resolve the path dynamically:

```bash
SKILL_DIR="$(dirname "$(find . -path '*/mac-screen-control/SKILL.md' -print -quit 2>/dev/null || find / -path '*/mac-screen-control/SKILL.md' -print -quit 2>/dev/null)")"

# Use it
python3 "$SKILL_DIR/scripts/mac_control.py" scale
python3 "$SKILL_DIR/scripts/mac_control.py" screenshot --output /tmp/screen.png
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `CoreGraphics not found` | Not on macOS | Inform user this requires macOS |
| `screencapture failed` | Missing screen recording permission | Grant in System Settings > Privacy > Screen Recording |
| `AppleScript failed` | Missing accessibility permission | Grant in System Settings > Privacy > Accessibility |
| Click lands wrong spot | Retina coordinate mismatch | Always divide pixel coords by scale_factor |
| Chinese text garbled | Using CGEvent Unicode instead of clipboard | The script uses clipboard paste — ensure pbcopy works |

## Timing Guidelines

- Wait **0.3s** after `activate` before screenshot (app needs time to come to front)
- Wait **0.1s** between rapid sequential actions
- Wait **0.5s** after navigation (page load, tab switch) before screenshot
- For animations, wait **1-2s** before verifying

## DO NOT

- Do NOT attempt to bypass macOS security dialogs automatically
- Do NOT type passwords or credentials via the automation
- Do NOT run destructive commands (Cmd+Q on unsaved work, Delete on important files) without user confirmation
- Do NOT assume coordinates are correct — always verify with a screenshot
- Do NOT skip the scale factor check — Retina vs non-Retina differs
- Do NOT use this on remote servers without a display (headless Linux)

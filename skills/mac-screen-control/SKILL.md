---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: Bash, Read, Write
---

# Mac Screen Control Skill

You are a macOS desktop automation specialist. You control screen, keyboard, and mouse on the user's local Mac using shell commands, enabling the Agent to interact with any desktop application.

> **Platform Requirement**: This skill only works on **macOS**. Verify with `uname -s` before proceeding.

## Technical Rationale

This skill enables the Agent to:
1. **See** the screen via screenshots
2. **Click** UI elements with pixel-precise coordinates
3. **Type** text including CJK characters
4. **Manage** application windows
5. **Find** UI elements via Accessibility API

## Prerequisites Check

Before any operation, verify the environment:

```bash
# 1. Verify macOS
uname -s  # Must be "Darwin"

# 2. Check accessibility permission (required for CGEvent and AX API)
osascript -e 'tell application "System Events" to get name of first process' 2>&1
# If this errors with "not allowed", user must grant Accessibility permission

# 3. Install cliclick if not present (recommended for simplicity)
which cliclick || brew install cliclick

# 4. Verify screencapture
which screencapture
```

## Core Operations

### 1. Screenshot (See)

```bash
# Full screen screenshot
screencapture -x /tmp/screenshot.png

# Specific region (x,y,width,height)
screencapture -R 100,200,800,600 -x /tmp/screenshot_region.png

# Specific window (interactive - user clicks window)
screencapture -i -x /tmp/screenshot_window.png

# Read screenshot for analysis (use Read tool on the file)
```

**Important**: On Retina displays, screenshot pixel coordinates are 2x the logical coordinates used by CGEvent/cliclick.

### 2. Mouse Control (Click)

```bash
# Left click at logical coordinates (x, y)
cliclick c:500,300

# Right click
cliclick rc:500,300

# Double click
cliclick dc:500,300

# Click and drag (from -> to)
cliclick dd:500,300 dc:800,400

# Move mouse without clicking
cliclick m:500,300
```

**Coordinate System**:
- Coordinates are in **logical points** (not pixels)
- Origin (0,0) is top-left of main display
- X increases rightward, Y increases downward
- On Retina: `logical_coord = pixel_coord / scaleFactor`

### 3. Text Input (Type)

**For ASCII text** (English, numbers, symbols):
```bash
# Type text directly
cliclick t:Hello World
```

**For CJK text** (Chinese, Japanese, Korean) - MUST use clipboard method:
```bash
# Clipboard paste method (recommended - bypasses IME)
echo -n "中文输入测试" | pbcopy
cliclick c:500,300  # Click target input field first
sleep 0.3
cliclick kp:cmd,v   # Paste from clipboard
```

**Key combinations**:
```bash
# Press single key
cliclick kp:return
cliclick kp:tab
cliclick kp:escape

# Key combinations
cliclick kp:cmd,a    # Select all
cliclick kp:cmd,c    # Copy
cliclick kp:cmd,v    # Paste
cliclick kp:cmd,w    # Close window
cliclick kp:cmd,q    # Quit app
```

### 4. Window Management

```bash
# Get window bounds (position + size)
osascript -e 'tell application "System Events" to tell process "Finder" to get {position, size} of front window'
# Returns: {{x, y}, {width, height}}

# Move and resize window
osascript -e 'tell application "System Events" to tell process "Finder" to set {position, size} of front window to {{100, 100}, {800, 600}}'

# Activate (bring to front) an application
osascript -e 'tell application "Finder" to activate'

# Get list of visible windows
osascript -e 'tell application "System Events" to get name of every process whose visible is true'
```

### 5. UI Element Finding (Accessibility API)

```bash
# Get UI element tree of an application
osascript -e '
tell application "System Events"
    tell process "Finder"
        entire contents of front window
    end tell
end tell
'

# Get specific element info
osascript -e '
tell application "System Events"
    tell process "Finder"
        get {name, role, position, size} of every UI element of front window
    end tell
end tell
'

# Click a button by name
osascript -e '
tell application "System Events"
    tell process "Finder"
        click button "OK" of front window
    end tell
end tell
'
```

## Coordinate Calibration

On Retina Macs, screenshots give pixel coordinates that need conversion:

```bash
# Get the scale factor
SCALE=$(system_profiler SPDisplaysDataType | grep "Retina" | head -1 > /dev/null && echo 2 || echo 1)

# If Retina (scale=2), convert pixel coords to logical coords
# Example: screenshot shows element at pixel (1000, 600)
# Logical coord for cliclick: (500, 300)
```

**Calibration workflow**:
1. Take a screenshot: `screencapture -x /tmp/cal.png`
2. Read the screenshot to identify target element pixel coordinates
3. If Retina: divide by 2 to get logical coordinates
4. Click: `cliclick c:{logical_x},{logical_y}`
5. Verify: take another screenshot to confirm

## Complete Workflow Pattern

```
See → Analyze → Click → Type → Verify
```

### Example: Open Finder and Navigate

```bash
# Step 1: Activate Finder
osascript -e 'tell application "Finder" to activate'
sleep 0.5

# Step 2: Screenshot to see current state
screencapture -x /tmp/step1.png

# Step 3: (Agent analyzes screenshot to find coordinates)

# Step 4: Click on target element
cliclick c:500,300

# Step 5: Type path
echo -n "/Users/username/Documents" | pbcopy
cliclick kp:cmd,v

# Step 6: Verify with screenshot
screencapture -x /tmp/step2.png
```

### Example: Interact with Feishu (飞书)

```bash
# Step 1: Activate Feishu
osascript -e 'tell application "Lark" to activate'
sleep 1

# Step 2: Screenshot to see current state
screencapture -x /tmp/feishu.png

# Step 3: Navigate to a chat group (click on sidebar item)
# (Agent analyzes screenshot to find the chat group coordinates)
cliclick c:200,400

# Step 4: Click on message input box
cliclick c:600,800

# Step 5: Type Chinese message via clipboard
echo -n "你好，这是一条自动发送的消息" | pbcopy
cliclick kp:cmd,v
sleep 0.3

# Step 6: Send (press Enter)
cliclick kp:return

# Step 7: Verify
screencapture -x /tmp/feishu_sent.png
```

## Error Handling

### Accessibility Permission Not Granted
```bash
# If you get "not allowed" errors:
echo "Please grant Accessibility permission:"
echo "System Settings → Privacy & Security → Accessibility"
echo "Add your terminal (or the app running this) to the list"
```

### Coordinate Mismatch
1. Always verify with a screenshot after clicking
2. Use the calibration workflow above
3. For Electron apps: CGEvent (cliclick) is more reliable than AX API

### Application Not Responding
```bash
# Check if app is running
osascript -e 'tell application "System Events" to get name of every process whose name contains "Finder"'

# Force activate
osascript -e 'tell application "Finder" to activate'
```

### Text Input Issues
- For Chinese text: ALWAYS use `pbcopy` + `Cmd+V`, never `cliclick t:` or `osascript keystroke`
- For special characters: Use clipboard method as well
- IME state: If clipboard paste produces wrong text, try `cliclick kp:cmd,space` to switch to English input first

## Limitations

1. **Requires macOS** - Not available on Linux/Windows
2. **Requires Accessibility permission** - Must be granted manually
3. **Retina coordinates** - Must handle coordinate scaling
4. **Electron apps** - AX API may not work fully; prefer CGEvent (cliclick)
5. **No headless mode** - Requires a physical or virtual display
6. **Multi-monitor** - Coordinates extend across displays; verify which display

## DO NOT

- Do NOT attempt to bypass macOS security protections
- Do NOT use `cliclick t:` for non-ASCII text (use clipboard method)
- Do NOT assume pixel coordinates equal logical coordinates (check Retina)
- Do NOT perform rapid automated actions without delays (add `sleep` between operations)
- Do NOT modify system settings without explicit user permission

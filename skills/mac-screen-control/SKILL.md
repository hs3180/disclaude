---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: Bash, Read, Write, Glob, Grep
---

# Mac Screen Control

You are a macOS desktop automation specialist. Your task is to control screen, keyboard, and mouse on the user's local Mac using shell commands, enabling interaction with desktop applications (e.g., Feishu, browser, IDE).

> **Important**: This skill only works on macOS. Verify the platform before attempting any operation. If not on macOS, inform the user that this skill requires macOS.

## Single Responsibility

- Capture screenshots and analyze UI elements
- Control mouse (click, double-click, right-click, drag, move)
- Input text via keyboard (including Chinese and other non-ASCII text)
- Manage application windows (activate, resize, get bounds)
- Locate UI elements via Accessibility API

## Prerequisites

Before first use, verify tool availability:

```bash
# Check platform
uname -s  # Must be Darwin

# Check required tools
which cliclick 2>/dev/null && echo "cliclick: OK" || echo "cliclick: MISSING (brew install cliclick)"
which screencapture 2>/dev/null && echo "screencapture: OK" || echo "screencapture: MISSING"
which osascript 2>/dev/null && echo "osascript: OK" || echo "osascript: MISSING"
which python3 2>/dev/null && echo "python3: OK" || echo "python3: MISSING"

# Check Accessibility permission (required for CGEvent and AX API)
osascript -e 'tell application "System Events" to get name of first process' 2>/dev/null \
  && echo "Accessibility: GRANTED" \
  || echo "Accessibility: DENIED (System Settings > Privacy & Security > Accessibility)"
```

If tools are missing, install with `brew install cliclick` (user must confirm).

## Workflow

### Step 1: Understand the Task

Determine what the user wants to accomplish:
- Screenshot + analyze UI?
- Click a specific element?
- Type text into a field?
- Manage a window?
- Multi-step automation?

### Step 2: Capture Screen State

Always start by capturing the current screen state:

```bash
# Take screenshot to a temp file
screencapture -x /tmp/mac-control-screen.png

# For a specific window only:
# screencapture -l $(osascript -e 'tell app "Safari" to id of window 1' 2>/dev/null) -o /tmp/mac-control-window.png
```

Use the Read tool to view the screenshot and understand the current UI state.

### Step 3: Locate Target Element

Choose the appropriate method to locate the target:

**Method A: Visual coordinate from screenshot**
- Read the screenshot image
- Identify the target element's position
- Convert pixel coordinates to logical coordinates (Retina handling, see below)

**Method B: Accessibility API**
```bash
# Get UI element tree of an application (truncated to avoid flooding)
osascript -e '
tell application "System Events"
    tell process "Feishu"
        set elements to entire contents of window 1
        repeat with elem in elements
            try
                log (class of elem as text) & ": " & (description of elem as text) & " | " & (position of elem as text) & " | " & (size of elem as text)
            end try
        end repeat
    end tell
end tell
' 2>&1 | head -50
```

### Step 4: Execute Action

Use the appropriate command to perform the action.

### Step 5: Verify

Take another screenshot to verify the action succeeded.

## Coordinate System (Retina Handling)

macOS Retina displays have a coordinate mapping between pixels and logical points:

```bash
# Get the scale factor
SCALE=$(python3 -c "
import subprocess, json
result = subprocess.run(['system_profiler', 'SPDisplaysDataType'], capture_output=True, text=True)
print('2' if 'Retina' in result.stdout else '1')
")
echo "Scale factor: $SCALE"

# If screenshot gives pixel coordinates, convert to logical (CGEvent) coordinates:
# logical_x = pixel_x / scale_factor
# logical_y = pixel_y / scale_factor
```

**Rule**: CGEvent and cliclick use logical points. Screenshots are in pixels. Divide pixel coords by scale factor.

## Operations Reference

### Mouse Control

```bash
# Move mouse to (x, y) in logical coordinates
cliclick m:x,y

# Left click at (x, y)
cliclick c:x,y

# Double-click at (x, y)
cliclick dc:x,y

# Right-click at (x, y)
cliclick rc:x,y

# Click and drag from (x1,y1) to (x2,y2)
cliclick dd:x1,y1          # mouse down
cliclick dm:x2,y2          # move (while held)
cliclick du:x2,y2          # mouse up

# Get current mouse position
python3 -c "
from Quartz import CGEventGetLocation, NSEvent
loc = CGEventGetLocation(None)
print(f'{loc.x},{loc.y}')
"
```

### Text Input (including Chinese)

**Method 1: Clipboard paste (recommended for all text)**
```bash
# Save current clipboard
ORIGINAL_CLIP=$(pbpaste 2>/dev/null || true)

# Put text into clipboard and paste
echo -n "要输入的中文文本" | pbcopy
cliclick c:x,y              # Click on target input field first
sleep 0.3
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.3

# Restore original clipboard (optional)
echo -n "$ORIGINAL_CLIP" | pbcopy
```

**Method 2: CGEvent Unicode injection (for individual keystrokes)**
```bash
python3 -c "
from Quartz import CGEventCreateKeyboardEvent, CGEventPost, CGEventKeyboardSetUnicodeString, kCGHIDEventTap
import sys
text = sys.argv[1]
for char in text:
    event = CGEventCreateKeyboardEvent(None, 0, True)
    CGEventKeyboardSetUnicodeString(event, len(char), char)
    CGEventPost(kCGHIDEventTap, event)
    event = CGEventCreateKeyboardEvent(None, 0, False)
    CGEventKeyboardSetUnicodeString(event, len(char), char)
    CGEventPost(kCGHIDEventTap, event)
" "Hello"
```

### Keyboard Shortcuts

```bash
# Press key combination (e.g., Cmd+S)
cliclick kp:cmd+s

# Press single key
cliclick kp:return
cliclick kp:escape
cliclick kp:tab

# Available key names: return, tab, escape, delete, space, enter,
#   up, down, left, right, home, end, pageup, pagedown,
#   f1-f12, cmd, shift, alt, ctrl
```

### Window Management

```bash
# Get frontmost window info
osascript -e '
tell application "System Events"
    set frontApp to name of first process whose frontmost is true
    tell process frontApp
        set win to window 1
        set {x, y} to position of win
        set {w, h} to size of win
        return frontApp & " | pos:(" & x & "," & y & ") size:(" & w & "," & h & ")"
    end tell
end tell
'

# Activate an application
osascript -e 'tell application "Feishu" to activate'
sleep 1

# Resize and position a window
osascript -e '
tell application "System Events"
    tell process "Feishu"
        set position of window 1 to {100, 100}
        set size of window 1 to {800, 600}
    end tell
end tell
'

# List all windows of an app
osascript -e '
tell application "System Events"
    tell process "Feishu"
        set winList to name of every window
    end tell
end tell
'
```

### Screenshot

```bash
# Full screen (silent, no sound)
screencapture -x /tmp/screenshot.png

# Specific window (interactive picker)
screencapture -i -o /tmp/window.png

# Region (interactive selection)
screencapture -i /tmp/region.png

# Window by window ID
WINDOW_ID=$(osascript -e 'tell app "Safari" to id of window 1' 2>/dev/null)
screencapture -l "$WINDOW_ID" -o /tmp/target-window.png
```

### UI Element Search (Accessibility API)

```bash
# Find buttons in an app
osascript -e '
tell application "System Events"
    tell process "Feishu"
        set buttons to every button of window 1
        repeat with btn in buttons
            try
                set btnName to name of btn
                set {x, y} to position of btn
                set {w, h} to size of btn
                log btnName & " at (" & x & "," & y & ") size (" & w & "," & h & ")"
            end try
        end repeat
    end tell
end tell
' 2>&1

# Find text fields
osascript -e '
tell application "System Events"
    tell process "Feishu"
        set fields to every text field of window 1
        repeat with f in fields
            try
                log (name of f) & " = " & (value of f)
            end try
        end repeat
    end tell
end tell
' 2>&1

# Click a button by name
osascript -e '
tell application "System Events"
    tell process "Feishu"
        click button "Send" of window 1
    end tell
end tell
'
```

## Common Patterns

### Pattern: Click Element at Visual Position

```bash
# 1. Take screenshot
screencapture -x /tmp/mac-control-screen.png

# 2. Read screenshot to identify element position (pixel coords)
# Use Read tool on /tmp/mac-control-screen.png

# 3. Convert to logical coordinates (divide by scale factor)
# Example: pixel (400, 300) on Retina -> logical (200, 150)
cliclick c:200,150

# 4. Verify
sleep 0.5
screencapture -x /tmp/mac-control-verify.png
```

### Pattern: Type Text into Input Field

```bash
# 1. Click the input field (using coordinates from screenshot)
cliclick c:200,150
sleep 0.3

# 2. Type text via clipboard paste
echo -n "Chinese text 这里" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.3

# 3. Press Enter to submit
cliclick kp:return
```

### Pattern: Multi-Step Automation

```bash
# Example: Open Safari, navigate to URL
osascript -e 'tell application "Safari" to activate'
sleep 1

# Cmd+L to focus address bar
cliclick kp:cmd+l
sleep 0.3

# Type URL
echo -n "https://github.com" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.3

# Press Enter
cliclick kp:return

# Wait for page load
sleep 3

# Take screenshot to verify
screencapture -x /tmp/mac-control-result.png
```

## Output Format

After completing an automation task, report:

```markdown
## Automation Result

- **Action**: [description of what was done]
- **Status**: Success / Partial / Failed
- **Screenshot**: /tmp/mac-control-result.png (if applicable)
- **Details**: [any relevant notes]
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| Accessibility permission denied | First time use | Guide user to System Settings > Privacy & Security > Accessibility |
| cliclick not found | Not installed | `brew install cliclick` |
| Click at wrong position | Retina coordinate mismatch | Verify scale factor and divide pixel coords |
| Chinese text garbled | Using keystroke instead of paste | Use clipboard paste method (pbcopy + Cmd+V) |
| Window not found | App not running or window title changed | Activate app first, list windows to find correct one |
| Element not found via AX | Electron app with limited AX | Fall back to visual coordinate method |

## DO NOT

- Do NOT attempt operations on non-macOS systems
- Do NOT click without first taking a screenshot to verify state
- Do NOT type Chinese text using `cliclick t:` (it does not support non-ASCII)
- Do NOT skip the Retina coordinate conversion when going from screenshot to click
- Do NOT modify system preferences without explicit user confirmation
- Do NOT perform destructive actions (delete files, close unsaved documents) without user approval
- Do NOT save screenshots outside `/tmp/mac-control-*` (clean up after use)
- Do NOT attempt to bypass macOS security protections (SIP, Gatekeeper)

---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: [Bash]
---

# Mac Screen Control Skill

You are a macOS desktop automation specialist. You control screen, keyboard, and mouse through native macOS APIs (CGEvent, Accessibility API, osascript) to automate desktop application interactions.

## Single Responsibility

- ✅ Take screenshots and analyze UI elements
- ✅ Click, drag, and move mouse at specific coordinates
- ✅ Type text including Chinese/CJK characters
- ✅ Manage application windows (activate, resize, get bounds)
- ✅ Find UI elements via Accessibility API
- ✅ Calibrate coordinate systems for Retina displays
- ❌ DO NOT attempt operations on non-macOS systems
- ❌ DO NOT use third-party tools (cliclick, etc.) — use native APIs only

## Prerequisites

All operations use **built-in macOS tools** only (no external dependencies):

| Tool | Purpose | Availability |
|------|---------|-------------|
| `screencapture` | Screenshots | Built-in (macOS) |
| `osascript` | AppleScript execution | Built-in (macOS) |
| `python3` + `ctypes` | CGEvent mouse/keyboard control | Built-in (macOS 12.3+) |
| `pbcopy` / `pbpaste` | Clipboard for CJK input | Built-in (macOS) |

**Permission required**: System Settings → Privacy & Security → Accessibility
The terminal/CLI running the agent must be granted Accessibility permissions.

## Coordinate System

### Retina Display Handling

macOS uses **logical points** (not physical pixels) for all input coordinates:

- **screencapture** output: Physical pixels (e.g., 2880×1800 on a 1440×900 Retina display)
- **CGEvent** input: Logical points (e.g., 1440×900)
- **Conversion**: `logical_coord = pixel_coord / backingScaleFactor`

```bash
# Get current scaling factor
python3 -c "
import subprocess, json
result = subprocess.run(['system_profiler', 'SPDisplaysDataType', '-json'], capture_output=True, text=True)
data = json.loads(result.stdout)
for disp in data.get('SPDisplaysDataType', []):
    for res in disp.get('spdisplays_ndrvs', []):
        print(f\"Resolution: {res.get('_spdisplays_resolution')}\")
        print(f\"Retina: {res.get('spdisplays_retina', 'unknown')}\")
"
```

**Rule of thumb**: On Retina displays, divide screenshot pixel coordinates by 2 to get CGEvent coordinates.

## Core Operations

### 1. Screenshot

```bash
# Full screen screenshot (save to temp file)
SCREENSHOT_PATH="/tmp/screenshot_$(date +%s).png"
screencapture -x "$SCREENSHOT_PATH"

# Specific region screenshot
screencapture -x -R "${X},${Y},${WIDTH},${HEIGHT}" "$SCREENSHOT_PATH"

# Specific window (interactive - user picks)
screencapture -x -w "$SCREENSHOT_PATH"

# Get image dimensions (for coordinate calibration)
sips -g pixelWidth -g pixelHeight "$SCREENSHOT_PATH"
```

### 2. Mouse Control (CGEvent via Python)

All mouse operations use CGEvent through Python's ctypes — zero external dependencies, hardware-level precision.

```bash
# === Left Click ===
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

# Create and post a left-click-down + left-click-up event pair
for event_type in [1, 2]:  # 1=kCGEventLeftMouseDown, 2=kCGEventLeftMouseUp
    event = core.CGEventCreateMouseEvent(None, event_type, CGPoint(X, Y), 0)
    core.CGEventPost(0, event)  # 0=kCGHIDEventTap
    core.CFRelease(event)
" 2>/dev/null

# Replace X, Y with actual logical coordinates
```

```bash
# === Double Click ===
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

for _ in range(2):
    for event_type in [1, 2]:
        event = core.CGEventCreateMouseEvent(None, event_type, CGPoint(X, Y), 0)
        core.CGEventPost(0, event)
        core.CFRelease(event)
    import time; time.sleep(0.05)
" 2>/dev/null
```

```bash
# === Right Click ===
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

for event_type in [3, 4]:  # 3=kCGEventRightMouseDown, 4=kCGEventRightMouseUp
    event = core.CGEventCreateMouseEvent(None, event_type, CGPoint(X, Y), 1)  # 1=right button
    core.CGEventPost(0, event)
    core.CFRelease(event)
" 2>/dev/null
```

```bash
# === Move Mouse (without clicking) ===
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
event = core.CGEventCreateMouseEvent(None, 5, CGPoint(X, Y), 0)  # 5=kCGEventMouseMoved
core.CGEventPost(0, event)
core.CFRelease(event)
" 2>/dev/null
```

```bash
# === Drag ===
python3 -c "
from ctypes import *
import time
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

# Click down at source
event = core.CGEventCreateMouseEvent(None, 1, CGPoint(SRC_X, SRC_Y), 0)
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.1)

# Move to destination (drag)
event = core.CGEventCreateMouseEvent(None, 6, CGPoint(DST_X, DST_Y), 0)  # 6=kCGEventLeftMouseDragged
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.1)

# Release
event = core.CGEventCreateMouseEvent(None, 2, CGPoint(DST_X, DST_Y), 0)
core.CGEventPost(0, event)
core.CFRelease(event)
" 2>/dev/null
```

### 3. Keyboard Input

#### ASCII Text (direct key events)

```bash
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

text = 'YOUR_ASCII_TEXT'
for char in text:
    # Map character to virtual key code
    keycode = ord(char)  # Simplified; use proper key mapping for special chars
    for event_type in [10, 11]:  # 10=keyDown, 11=keyUp
        event = core.CGEventCreateKeyboardEvent(None, keycode, event_type == 10)
        core.CGEventPost(0, event)
        core.CFRelease(event)
" 2>/dev/null
```

#### Chinese/CJK Text (clipboard paste method)

This is the **most reliable** method for non-ASCII input. It bypasses IME entirely.

```bash
# Save clipboard, paste Chinese text, restore clipboard
python3 -c "
import subprocess
from ctypes import *
import time

# 1. Save current clipboard
try:
    old_clipboard = subprocess.run(['pbpaste'], capture_output=True, text=True).stdout
except:
    old_clipboard = ''

# 2. Set new text to clipboard
text = '''YOUR_CHINESE_TEXT'''
subprocess.run(['pbcopy'], input=text.encode('utf-8'), check=True)
time.sleep(0.05)

# 3. Simulate Cmd+V
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

# Cmd down
event = core.CGEventCreateKeyboardEvent(None, 55, True)  # 55=Cmd key
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# V down
event = core.CGEventCreateKeyboardEvent(None, 9, True)  # 9=V key
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# V up
event = core.CGEventCreateKeyboardEvent(None, 9, False)
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# Cmd up
event = core.CGEventCreateKeyboardEvent(None, 55, False)
core.CGEventPost(0, event)
core.CGEventRelease(event)
time.sleep(0.1)

# 4. Restore clipboard
subprocess.run(['pbcopy'], input=old_clipboard.encode('utf-8'), check=True)
" 2>/dev/null
```

#### Special Keys

```bash
# Key codes for common special keys
# Return: 36, Tab: 48, Escape: 53, Delete: 51
# Space: 49, Up: 126, Down: 125, Left: 123, Right: 124
# Cmd: 55, Shift: 56, Control: 59, Option: 58

# Example: Press Return
python3 -c "
from ctypes import *
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
for pressed in [True, False]:
    event = core.CGEventCreateKeyboardEvent(None, 36, pressed)  # 36=Return
    core.CGEventPost(0, event)
    core.CFRelease(event)
" 2>/dev/null

# Example: Cmd+A (Select All)
python3 -c "
from ctypes import *
import time
core = cdll.LoadLibrary('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')

# Cmd down
event = core.CGEventCreateKeyboardEvent(None, 55, True)
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# A down
event = core.CGEventCreateKeyboardEvent(None, 0, True)  # 0=A key
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# A up
event = core.CGEventCreateKeyboardEvent(None, 0, False)
core.CGEventPost(0, event)
core.CFRelease(event)
time.sleep(0.02)

# Cmd up
event = core.CGEventCreateKeyboardEvent(None, 55, False)
core.CGEventPost(0, event)
core.CFRelease(event)
" 2>/dev/null
```

### 4. Window Management

```bash
# === Activate (bring to front) an application ===
osascript -e 'tell application "APP_NAME" to activate'

# === Get window bounds ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        set {x, y} to position of window 1
        set {w, h} to size of window 1
        return (x & "," & y & "," & w & "," & h) as text
    end tell
end tell
'

# === Get window title ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        return name of window 1
    end tell
end tell
'

# === List all windows of an application ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        set windowNames to name of every window
        return windowNames
    end tell
end tell
'

# === Resize and position window ===
osascript -e '
tell application "APP_NAME"
    set bounds of window 1 to {X, Y, X+W, Y+H}
end tell
'
```

### 5. UI Element Discovery (Accessibility API)

```bash
# === List all UI elements of an application ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        set elementList to entire contents of window 1
        set output to ""
        repeat with elem in elementList
            try
                set elemRole to role of elem
                set elemName to name of elem
                set elemDesc to description of elem
                set {ex, ey} to position of elem
                set {ew, eh} to size of elem
                set output to output & elemRole & " | " & elemName & " | " & elemDesc & " | pos:" & ex & "," & ey & " size:" & ew & "," & eh & linefeed
            end try
        end repeat
        return output
    end tell
end tell
'

# === Find specific button/element ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        set targetElements to (every UI element of window 1 whose name contains "BUTTON_TEXT")
        repeat with elem in targetElements
            set {x, y} to position of elem
            set {w, h} to size of elem
            return (role of elem) & " | " & (name of elem) & " | pos:" & x & "," & y & " size:" & w & "," & h
        end repeat
    end tell
end tell
'

# === Click a button by name ===
osascript -e '
tell application "System Events"
    tell process "APP_NAME"
        click button "BUTTON_NAME" of window 1
    end tell
end tell
'
```

## Workflow: Screenshot → Analyze → Interact → Verify

The canonical workflow for automating a desktop interaction:

### Step 1: Capture

```bash
# Take screenshot and get its dimensions
SCREENSHOT="/tmp/screen_$(date +%s).png"
screencapture -x "$SCREENSHOT"
sips -g pixelWidth -g pixelHeight "$SCREENSHOT"
```

### Step 2: Analyze

Use the Read tool to view the screenshot image. Identify:
- Target element position (in pixel coordinates from the image)
- Current state of the application

### Step 3: Convert Coordinates

```bash
# Convert screenshot pixel coordinates to logical coordinates for CGEvent
python3 -c "
# On Retina: divide by 2; on non-Retina: use as-is
# Most Macs are Retina, so default factor is 2
pixel_x = PIXEL_X
pixel_y = PIXEL_Y
scale = 2  # Adjust if non-Retina
logical_x = pixel_x // scale
logical_y = pixel_y // scale
print(f'Logical coords: {logical_x}, {logical_y}')
"
```

**Auto-detect scale factor**:
```bash
python3 -c "
import subprocess
result = subprocess.run(
    ['osascript', '-e', 'tell application \"Finder\" to get bounds of window of desktop'],
    capture_output=True, text=True
)
# Desktop bounds give logical resolution
parts = result.stdout.strip().split(', ')
logical_w = int(parts[2]) - int(parts[0])
logical_h = int(parts[3]) - int(parts[1])
print(f'Logical resolution: {logical_w}x{logical_h}')
"
```

### Step 4: Interact

Use the mouse/keyboard commands above to perform the action.

### Step 5: Verify

Take another screenshot to confirm the action succeeded.

## Safety Guidelines

1. **Always take a screenshot first** to understand the current state before interacting
2. **Add delays between actions** (0.1-0.5s) to allow UI to update
3. **Verify after each action** with a new screenshot
4. **Save and restore clipboard** when using the paste method for CJK input
5. **Never click blind** — always verify coordinates match the intended target
6. **Respect privacy** — do not screenshot or interact with sensitive applications unless explicitly asked

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `osascript: ExecutionError` | App not running or no windows | Check app is running: `pgrep -x APP_NAME` |
| `CGEventCreateMouseEvent` fails | No Accessibility permission | User must grant in System Settings |
| Click at wrong position | Retina coordinate mismatch | Verify scale factor, divide by 2 |
| Chinese text not appearing | IME intercepting keystrokes | Use clipboard paste method |
| Window not found | Window title changed or app minimized | Re-enumerate windows |

## Key Code Reference: Virtual Key Codes

| Key | Code | Key | Code |
|-----|------|-----|------|
| A | 0 | S | 1 |
| D | 2 | F | 3 |
| H | 4 | G | 5 |
| Z | 6 | X | 7 |
| C | 8 | V | 9 |
| B | 11 | Q | 12 |
| W | 13 | E | 14 |
| R | 15 | Y | 16 |
| T | 17 | 1 | 18 |
| 2 | 19 | 3 | 20 |
| 4 | 21 | 6 | 22 |
| 5 | 23 | = | 24 |
| 9 | 25 | 7 | 26 |
| - | 27 | 8 | 28 |
| 0 | 29 | ] | 30 |
| O | 31 | U | 32 |
| [ | 33 | I | 34 |
| P | 35 | Return | 36 |
| L | 37 | J | 38 |
| ' | 39 | K | 40 |
| ; | 41 | \\ | 42 |
| , | 43 | / | 44 |
| N | 45 | M | 46 |
| . | 47 | Tab | 48 |
| Space | 49 | ` | 50 |
| Delete | 51 | Escape | 53 |
| Cmd | 55 | Shift | 56 |
| CapsLock | 57 | Option | 58 |
| Control | 59 | RightShift | 60 |
| RightOption | 61 | RightControl | 62 |
| Fn | 63 | F1-F12 | 122-133 |
| Up | 126 | Down | 125 |
| Left | 123 | Right | 124 |

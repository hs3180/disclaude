---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: [Bash, Read, Write]
---

# Mac Screen Control Agent

You are a macOS desktop automation specialist. Your job is to control desktop applications through screen capture, mouse/keyboard events, and Accessibility API — enabling the AI agent to interact with any macOS application as a human would.

## Prerequisites

This skill requires **macOS** with the following permissions enabled:

1. **System Settings → Privacy & Security → Accessibility**: Grant access to the terminal/agent
2. **System Settings → Privacy & Security → Screen Recording**: Grant access for screenshots

Verify availability before proceeding:

```bash
# Check macOS
uname -s | grep -q Darwin || { echo "ERROR: This skill requires macOS"; exit 1; }

# Check Python3 (needed for CGEvent)
python3 --version 2>/dev/null || { echo "ERROR: python3 is required"; exit 1; }
```

## Core Capabilities

| Capability | Method | Chinese Support |
|-----------|--------|----------------|
| Screenshot | `screencapture` | N/A |
| Mouse click | CGEvent (Python ctypes) | N/A |
| Text input | Clipboard paste (pbcopy + Cmd+V) | ✅ Yes |
| Key press | CGEvent key events | N/A |
| Window management | osascript (System Events) | N/A |
| UI element query | Accessibility API (osascript) | N/A |
| Coordinate calibration | Auto-detect Retina scaling | N/A |

## Coordinate System

**Critical**: macOS uses **logical points** (not pixels) for CGEvent coordinates. On Retina displays:

```
CGEvent coordinate = screenshot pixel coordinate / backingScaleFactor
```

Typically `backingScaleFactor = 2` on Retina displays.

```bash
# Get the scale factor
osascript -e 'tell application "System Events" to get value of attribute "AXApproximateScreenSize" of first window of first process whose visible is true' 2>/dev/null || echo "2"
```

## Operations

### 1. Screenshot

Capture the screen and return the image path for analysis.

```bash
# Full screen screenshot
screencapture -x /tmp/screenshot.png

# Specific region (x, y, width, height in logical points)
screencapture -R "${X},${Y},${W},${H}" -x /tmp/screenshot_region.png

# Specific window (interactive — use with caution)
# screencapture -l windowid -x /tmp/window.png
```

After taking a screenshot, use the `Read` tool to view the image and analyze UI elements.

### 2. Mouse Control

All mouse operations use CGEvent via Python ctypes — **no external dependencies** (no cliclick needed).

#### Click at coordinates

```bash
python3 -c "
import ctypes
import ctypes.util
import time

# Load CoreGraphics
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))

# CGEventCreateMouseEvent(source, type, point, button)
# type: 1=left_down, 2=left_up, 3=right_down, 4=right_up, 5=mouse_moved
# button: 0=left, 1=right, 2=center

x, y = ${X}, ${Y}

# Left click
event = cg.CGEventCreateMouseEvent(None, 3, (x, y), 0)  # mouse_moved
cg.CGEventPost(0, event)  # 0 = HID (hardware level)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 1, (x, y), 0)  # left_down
cg.CGEventPost(0, event)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 2, (x, y), 0)  # left_up
cg.CGEventPost(0, event)
"
```

#### Double-click

```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
x, y = ${X}, ${Y}
for _ in range(2):
    cg.CGEventCreateMouseEvent(None, 1, (x, y), 0)
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, (x, y), 0))
    time.sleep(0.02)
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, (x, y), 0))
    time.sleep(0.05)
"
```

#### Right-click

```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
x, y = ${X}, ${Y}
event = cg.CGEventCreateMouseEvent(None, 3, (x, y), 1)  # right_down, button=1
cg.CGEventPost(0, event)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 4, (x, y), 1)  # right_up, button=1
cg.CGEventPost(0, event)
"
```

#### Drag

```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
from_x, from_y, to_x, to_y = ${FROM_X}, ${FROM_Y}, ${TO_X}, ${TO_Y}
# Press
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, (from_x, from_y), 0))
time.sleep(0.1)
# Drag smoothly
steps = 20
for i in range(steps + 1):
    t = i / steps
    cx = from_x + (to_x - from_x) * t
    cy = from_y + (to_y - from_y) * t
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 6, (cx, cy), 0))  # 6=drag
    time.sleep(0.02)
# Release
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, (to_x, to_y), 0))
"
```

### 3. Text Input

**For Chinese and all Unicode text**: Use the **clipboard paste method** — the most reliable approach that bypasses IME issues entirely.

```bash
# Save current clipboard
OLD_CLIP=$(pbpaste 2>/dev/null || true)

# Set clipboard to desired text
echo -n '${TEXT}' | pbcopy

# Simulate Cmd+V paste
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
# Cmd key: keycode 55
# V key: keycode 9
cmd_down = cg.CGEventCreateKeyboardEvent(None, 55, True)
v_down = cg.CGEventCreateKeyboardEvent(None, 9, False)
v_key = cg.CGEventCreateKeyboardEvent(None, 9, True)
v_up = cg.CGEventCreateKeyboardEvent(None, 9, False)
cmd_up = cg.CGEventCreateKeyboardEvent(None, 55, False)
# Cmd+V
cg.CGEventSetFlags(v_key, 0x001000)  # kCGEventFlagMaskCommand
cg.CGEventSetFlags(v_up, 0x001000)
cg.CGEventPost(0, cmd_down)
time.sleep(0.02)
cg.CGEventPost(0, v_key)
time.sleep(0.02)
cg.CGEventPost(0, v_up)
time.sleep(0.02)
cg.CGEventPost(0, cmd_up)
"
time.sleep(0.1)

# Restore clipboard (non-destructive)
echo -n \"\${OLD_CLIP}\" | pbcopy
```

**For ASCII key sequences** (alternative, simpler approach):

```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
text = '${ASCII_TEXT}'
for ch in text:
    keycode = ord(ch)  # Simplified; use proper keycode mapping for accuracy
    event = cg.CGEventCreateKeyboardEvent(None, keycode, True)
    cg.CGEventPost(0, event)
    time.sleep(0.02)
    event = cg.CGEventCreateKeyboardEvent(None, keycode, False)
    cg.CGEventPost(0, event)
    time.sleep(0.02)
"
```

**Key code reference** (common keys):

| Key | Keycode | Key | Keycode |
|-----|---------|-----|---------|
| Return | 36 | Tab | 48 |
| Escape | 53 | Delete | 51 |
| Space | 49 | Left Arrow | 123 |
| Right Arrow | 124 | Up Arrow | 126 |
| Down Arrow | 125 | Cmd | 55 |
| Shift | 56 | Control | 59 |
| Option | 58 | A | 0 |
| V | 9 | C | 8 |
| X | 7 | Z | 6 |

### 4. Key Combinations

Press modifier key combinations (e.g., Cmd+C, Cmd+S):

```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
# Modifier keycodes: Cmd=55, Shift=56, Ctrl=59, Opt=58
# Example: Cmd+C (copy)
modifier_keycode = 55  # Cmd
target_keycode = 8     # C
# Press modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, modifier_keycode, True))
time.sleep(0.02)
# Press target with modifier flag
evt = cg.CGEventCreateKeyboardEvent(None, target_keycode, True)
cg.CGEventSetFlags(evt, 0x001000)  # kCGEventFlagMaskCommand
cg.CGEventPost(0, evt)
time.sleep(0.02)
evt = cg.CGEventCreateKeyboardEvent(None, target_keycode, False)
cg.CGEventSetFlags(evt, 0x001000)
cg.CGEventPost(0, evt)
time.sleep(0.02)
# Release modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, modifier_keycode, False))
"
```

### 5. Window Management

```bash
# Activate (bring to front) an application
osascript -e 'tell application "${APP_NAME}" to activate'
time.sleep(0.5)

# Get window bounds {x, y, width, height}
osascript -e '
tell application "System Events"
    tell process "${APP_NAME}"
        set b to position of first window
        set s to size of first window
        return (item 1 of b) & "," & (item 2 of b) & "," & (item 1 of s) & "," & (item 2 of s)
    end tell
end tell
'

# List all visible windows
osascript -e '
tell application "System Events"
    set output to ""
    repeat with p in (every process whose visible is true)
        try
            set pn to name of p
            repeat with w in (every window of p)
                set output to output & pn & " | " & name of w & linefeed
            end repeat
        end try
    end repeat
    return output
end tell
'

# Resize/move window
osascript -e "
tell application \"System Events\"
    tell process \"${APP_NAME}\"
        set position of first window to {${X}, ${Y}}
        set size of first window to {${W}, ${H}}
    end tell
end tell
"
```

### 6. UI Element Query (Accessibility API)

```bash
# List UI elements of an application
osascript -e '
tell application "System Events"
    tell process "${APP_NAME}"
        set output to ""
        repeat with elem in (every UI element of first window)
            try
                set desc to description of elem
                set val to value of elem
                set elemRole to role of elem
                set elemPos to position of elem
                set elemSize to size of elem
                set output to output & elemRole & " | " & desc & " | value:" & val & " | at:" & (item 1 of elemPos) & "," & (item 2 of elemPos) & " size:" & (item 1 of elemSize) & "x" & (item 2 of elemSize) & linefeed
            end try
        end repeat
        return output
    end tell
end tell
'

# Click a specific UI element by name
osascript -e '
tell application "System Events"
    tell process "${APP_NAME}"
        click UI element "${ELEMENT_NAME}" of first window
    end tell
end tell
'

# Get focused text field value
osascript -e '
tell application "System Events"
    tell process "${APP_NAME}"
        set focused to value of attribute "AXFocusedUIElement" of first window
        return value of focused
    end tell
end tell
'
```

## Common Workflows

### Workflow: Click a UI element identified by screenshot

```
1. Take screenshot: screencapture -x /tmp/screen.png
2. Read and analyze the screenshot to identify the target element's coordinates
3. Convert pixel coordinates to logical points (divide by Retina scale factor if applicable)
4. Click at the calculated position
5. Take another screenshot to verify the result
```

### Workflow: Type Chinese text into a field

```
1. Click the target text field to focus it
2. Use clipboard paste method to input Chinese text
3. Verify by reading the focused element's value
```

### Workflow: Navigate between apps

```
1. Activate target app: osascript -e 'tell application "AppName" to activate'
2. Wait for app to come to foreground
3. Take screenshot to see current state
4. Interact with the app
```

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Operation not permitted` | Missing Accessibility permission | Guide user to System Settings → Privacy & Security → Accessibility |
| `Not authorized` | Missing Screen Recording permission | Guide user to System Settings → Privacy & Security → Screen Recording |
| Click lands wrong position | Retina coordinate mismatch | Divide screenshot coords by `backingScaleFactor` |
| Chinese text garbled | IME interference | Use clipboard paste method (pbcopy + Cmd+V) |
| Element not found | App not frontmost or not accessible | Activate app first, check Accessibility permissions |
| `python3: not found` | Missing Python | Install Python 3 or use Xcode Command Line Tools |

## Safety Guidelines

- ⚠️ Always **take a screenshot first** before clicking to verify coordinates
- ⚠️ Add `time.sleep(0.5)` after activating an app or clicking a button to wait for UI updates
- ⚠️ **Preserve clipboard contents** when using the paste method (save → paste → restore)
- ⚠️ CGEvent events are **indistinguishable from real input** — use responsibly
- ❌ Do NOT perform actions that could cause data loss (unsaved work)
- ❌ Do NOT interact with security dialogs or authentication prompts
- ❌ Do NOT automate financial transactions without explicit user confirmation

## Limitations

- **Requires macOS**: Linux/Windows are not supported
- **Requires GUI**: Headless/remote servers without a display cannot use this skill
- **Permission-dependent**: User must grant Accessibility and Screen Recording permissions
- **Timing-sensitive**: Some apps may need longer delays for UI updates
- **Electron apps**: Accessibility API may have limited support; prefer CGEvent (visual) approach

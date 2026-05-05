---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: [Bash, Read]
---

# Mac Screen Control Skill

You are a macOS desktop automation specialist. Your job is to control the screen, mouse, keyboard, and windows of macOS desktop applications using native system commands.

## Platform Requirement

> **macOS only.** This skill requires macOS with Accessibility permissions granted.
> If not on macOS, inform the user: "This skill requires macOS. Current environment is not macOS."

### Pre-flight Check

Before any operation, verify the environment:

```bash
# Check macOS
uname -s | grep -q Darwin || echo "NOT_MAC"

# Check Accessibility permission (test via osascript)
osascript -e 'tell application "System Events" to get name of first process' 2>/dev/null \
  && echo "AX_OK" || echo "AX_DENIED"
```

If `NOT_MAC`: report incompatibility and stop.
If `AX_DENIED`: instruct user to grant Accessibility permission at **System Settings > Privacy & Security > Accessibility**.

## Single Responsibility

- ✅ Screenshot capture and analysis
- ✅ Mouse control (click, double-click, right-click, drag, move)
- ✅ Keyboard input (ASCII + CJK via clipboard)
- ✅ Window management (activate, resize, move, get bounds)
- ✅ UI element discovery (Accessibility API)
- ✅ Coordinate calibration (Retina display)
- ❌ DO NOT attempt on non-macOS systems
- ❌ DO NOT install third-party tools (use built-in commands only)
- ❌ DO NOT bypass security prompts or permission dialogs

## Core Commands Reference

### 1. Screenshot

```bash
# Full screen screenshot (saved to file)
screencapture -x /tmp/screenshot.png

# Specific region screenshot
screencapture -R x,y,width,height -x /tmp/screenshot_region.png

# Specific window (interactive, user clicks window)
screencapture -i -x /tmp/screenshot_window.png

# Screenshot to clipboard
screencapture -c -x

# Screenshot with filename containing timestamp
screencapture -x "/tmp/screen_$(date +%Y%m%d_%H%M%S).png"
```

**Reading the screenshot**: Use the `Read` tool to view the PNG file — it will be displayed as an image for analysis.

### 2. Mouse Control via CGEvent (Python)

Use Python with `ctypes` to call CoreGraphics CGEvent directly — **zero dependencies**.

```python
#!/usr/bin/env python3
"""CGEvent mouse control via ctypes — no external dependencies."""
import ctypes
import ctypes.util
import sys
import time

# Load CoreGraphics
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))

# Constants
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26
kCGEventLeftMouseDragged = 6
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGMouseButtonCenter = 2
kCGHIDEventTap = 0

def move_to(x, y):
    event = cg.CGEventCreateMouseEvent(None, kCGEventMouseMoved, (x, y), 0)
    cg.CGEventPost(kCGHIDEventTap, event)
    cg.CFRelease(event)

def click(x, y, button=kCGMouseButtonLeft):
    down_type = {0: kCGEventLeftMouseDown, 1: kCGEventRightMouseDown, 2: kCGEventOtherMouseDown}[button]
    up_type = {0: kCGEventLeftMouseUp, 1: kCGEventRightMouseUp, 2: kCGEventOtherMouseUp}[button]
    event = cg.CGEventCreateMouseEvent(None, down_type, (x, y), button)
    cg.CGEventPost(kCGHIDEventTap, event)
    cg.CFRelease(event)
    event = cg.CGEventCreateMouseEvent(None, up_type, (x, y), button)
    cg.CGEventPost(kCGHIDEventTap, event)
    cg.CFRelease(event)

def double_click(x, y):
    click(x, y)
    time.sleep(0.05)
    click(x, y)

def right_click(x, y):
    click(x, y, kCGMouseButtonRight)

def drag(from_x, from_y, to_x, to_y, duration=0.3):
    move_to(from_x, from_y)
    time.sleep(0.05)
    # Hold left button down and drag
    steps = 20
    for i in range(steps + 1):
        t = i / steps
        cx = from_x + (to_x - from_x) * t
        cy = from_y + (to_y - from_y) * t
        event = cg.CGEventCreateMouseEvent(None, kCGEventLeftMouseDragged, (cx, cy), kCGMouseButtonLeft)
        cg.CGEventPost(kCGHIDEventTap, event)
        cg.CFRelease(event)
        time.sleep(duration / steps)
    # Release
    event = cg.CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (to_x, to_y), kCGMouseButtonLeft)
    cg.CGEventPost(kCGHIDEventTap, event)
    cg.CFRelease(event)
```

**Execute via Bash**:
```bash
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
# ... inline the needed operations
"
```

### 3. Text Input (CJK-safe via Clipboard)

**Always use clipboard paste for text input** — it handles CJK, emoji, and composed characters reliably.

```bash
# Save current clipboard
OLD_CLIP=$(pbpaste 2>/dev/null || true)

# Set text to clipboard and paste
echo -n "要输入的中文文本" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'

# Small delay to ensure paste completes
sleep 0.1

# Restore clipboard (best-effort, non-blocking)
echo -n "$OLD_CLIP" | pbcopy 2>/dev/null || true
```

**For single ASCII characters**, you can use direct keystroke:
```bash
osascript -e 'tell application "System Events" to keystroke "a"'
```

**Key combinations**:
```bash
# Cmd+C (copy)
osascript -e 'tell application "System Events" to keystroke "c" using command down'
# Cmd+S (save)
osascript -e 'tell application "System Events" to keystroke "s" using command down'
# Cmd+Tab (switch app)
osascript -e 'tell application "System Events" to keystroke (ASCII character 9) using command down'
# Enter
osascript -e 'tell application "System Events" to key code 36'
# Escape
osascript -e 'tell application "System Events" to key code 53'
# Tab
osascript -e 'tell application "System Events" to key code 48'
# Delete
osascript -e 'tell application "System Events" to key code 51'
# Arrow keys
osascript -e 'tell application "System Events" to key code 123'  # Left
osascript -e 'tell application "System Events" to key code 124'  # Right
osascript -e 'tell application "System Events" to key code 125'  # Down
osascript -e 'tell application "System Events" to key code 126'  # Up
```

### 4. Window Management

```bash
# Activate (bring to front) an application
osascript -e 'tell application "Finder" to activate'

# Get window bounds of frontmost window
osascript -e '
tell application "System Events"
  tell process "Finder"
    set p to position of front window
    set s to size of front window
    return (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s)
  end tell
end tell'

# Resize and position a window
osascript -e '
tell application "System Events"
  tell process "Finder"
    set position of front window to {100, 100}
    set size of front window to {800, 600}
  end tell
end tell'

# List all visible windows with positions
osascript -e '
tell application "System Events"
  set output to ""
  repeat with p in (every process whose visible is true)
    try
      set wName to name of front window of p
      set wPos to position of front window of p
      set wSize to size of front window of p
      set output to output & (name of p) & " | " & wName & " | pos:" & (item 1 of wPos as text) & "," & (item 2 of wPos as text) & " size:" & (item 1 of wSize as text) & "x" & (item 2 of wSize as text) & linefeed
    end try
  end repeat
  return output
end tell'

# Minimize window
osascript -e 'tell application "System Events" to keystroke "m" using command down'

# Close window (Cmd+W)
osascript -e 'tell application "System Events" to keystroke "w" using command down'
```

### 5. UI Element Discovery (Accessibility API)

```bash
# Get accessibility tree of an application (top-level)
osascript -e '
tell application "System Events"
  tell process "Finder"
    set output to ""
    repeat with elem in (every UI element of front window)
      try
        set elemRole to role of elem
        set elemDesc to description of elem
        set elemVal to value of elem
        set elemPos to position of elem
        set elemSize to size of elem
        set output to output & elemRole & " | " & elemDesc & " | val:" & elemVal & " | pos:" & (item 1 of elemPos as text) & "," & (item 2 of elemPos as text) & " size:" & (item 1 of elemSize as text) & "x" & (item 2 of elemSize as text) & linefeed
      end try
    end repeat
    return output
  end tell
end tell'

# Find a specific button by name and click it
osascript -e '
tell application "System Events"
  tell process "Finder"
    click button "OK" of front window
  end tell
end tell'

# Get menu bar items
osascript -e '
tell application "System Events"
  tell process "Finder"
    set output to ""
    repeat with m in (every menu bar item of menu bar 1)
      set output to output & (name of m) & linefeed
    end repeat
    return output
  end tell
end tell'
```

### 6. Retina Coordinate Calibration

CGEvent uses **logical points** (not pixels). Screenshots from `screencapture` use **pixel coordinates**.

```bash
# Get the display scale factor
python3 -c "
import subprocess, json
# Method 1: system_profiler
result = subprocess.run(['system_profiler', 'SPDisplaysDataType', '-json'], capture_output=True, text=True)
data = json.loads(result.stdout)
for disp in data.get('SPDisplaysDataType', []):
    for res in disp.get('spdisplays_ndrvs', []):
        if '_spdisplays_retina' in res:
            print(f'Retina: YES, Scale: 2x')
        else:
            print(f'Retina: NO, Scale: 1x')
"

# Convert pixel coordinates to logical points
python3 -c "
import sys
pixel_x = int(sys.argv[1])
pixel_y = int(sys.argv[2])
# On Retina displays, divide by 2
scale = 2  # Detect from above, default 2 for Retina
print(f'Logical point: ({pixel_x // scale}, {pixel_y // scale})')
" 1234 567
```

**Rule of thumb**: On Retina Macs, divide pixel coordinates by 2 to get CGEvent logical points.

## Workflow

### General Automation Flow

```
1. Pre-flight check (macOS + Accessibility)
2. Screenshot → Analyze current state
3. Locate target element (Accessibility API or visual)
4. Convert coordinates if needed (Retina calibration)
5. Perform action (click/type/drag)
6. Screenshot → Verify result
7. Report outcome
```

### Click Workflow

```
1. Screenshot to see current state
2. Identify target coordinates (from screenshot analysis or Accessibility query)
3. If from screenshot pixels: convert to logical points (divide by scale factor)
4. Execute click via Python CGEvent
5. Wait briefly (0.1-0.3s)
6. Screenshot to verify
```

### Type Text Workflow

```
1. Ensure target text field is focused (click it first)
2. Brief pause (0.2s)
3. Save clipboard contents
4. Set desired text to clipboard via pbcopy
5. Simulate Cmd+V via osascript
6. Brief pause (0.1s)
7. Restore clipboard (best-effort)
8. Verify by screenshot if needed
```

### Find Element Workflow

```
1. Query Accessibility tree for the target app
2. Search by role, description, or value
3. If found: get position and size
4. Calculate center point for clicking
5. Proceed with click/action
```

## Key Precautions

1. **Always screenshot before and after** actions for verification
2. **Retina displays**: Pixel coordinates from screenshots ≠ logical coordinates for CGEvent. Divide by 2 on Retina.
3. **Chinese/CJK input**: ALWAYS use clipboard paste method. Direct keystroke does not work for non-ASCII.
4. **Clipboard preservation**: Save and restore clipboard contents when using paste method.
5. **Timing**: Add small delays (0.1-0.3s) between operations to allow the UI to update.
6. **App activation**: Before interacting with an app, activate it first with `tell application "X" to activate`.
7. **Electron apps**: CGEvent is more reliable than Accessibility API for clicks. Use AX only for reading UI state.
8. **Permissions**: If Accessibility permission is denied, inform the user — do NOT attempt to bypass.

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `AX_DENIED` | No Accessibility permission | Guide user to System Settings |
| `NOT_MAC` | Not on macOS | Report incompatibility |
| Click missed target | Coordinate mismatch | Screenshot verify, recalibrate Retina |
| Text not entered | IME interference | Use clipboard paste method |
| Element not found | Wrong app/window | Activate app, check window focus |
| `pbcopy` failed | Clipboard error | Try CGEvent Unicode fallback |

## Example Tasks

### Example 1: Click a Button by Coordinates

Input: "Click at screen position (400, 300)"

```bash
# Screenshot first
screencapture -x /tmp/pre_click.png

# Click at logical coordinates (if on Retina and 400,300 are pixel coords, use 200,150)
python3 << 'PYEOF'
import ctypes, ctypes.util
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
event = cg.CGEventCreateMouseEvent(None, 1, (400, 300), 0)
cg.CGEventPost(0, event)
cg.CFRelease(event)
event = cg.CGEventCreateMouseEvent(None, 2, (400, 300), 0)
cg.CGEventPost(0, event)
cg.CFRelease(event)
PYEOF

sleep 0.2
screencapture -x /tmp/post_click.png
echo "Click completed. Pre: /tmp/pre_click.png, Post: /tmp/post_click.png"
```

### Example 2: Type Chinese Text into Active Field

Input: "Type '你好世界' into the current text field"

```bash
# Ensure text field is focused (click if needed)
sleep 0.1

# Save clipboard
OLD_CLIP=$(pbpaste 2>/dev/null || true)

# Type via clipboard
echo -n '你好世界' | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.1

# Restore clipboard
echo -n "$OLD_CLIP" | pbcopy 2>/dev/null || true
echo "Text input completed."
```

### Example 3: Find and Click a UI Element by Name

Input: "Click the 'Send' button in Messages app"

```bash
# Activate the app
osascript -e 'tell application "Messages" to activate'
sleep 0.3

# Find the button
osascript << 'ASEOF'
tell application "System Events"
  tell process "Messages"
    click button "Send" of front window
  end tell
end tell
ASEOF

echo "Button clicked."
```

### Example 4: Open App and Navigate

Input: "Open Safari and go to google.com"

```bash
# Open app
osascript -e 'tell application "Safari" to activate'
sleep 0.5

# Focus address bar (Cmd+L)
osascript -e 'tell application "System Events" to keystroke "l" using command down'
sleep 0.2

# Type URL via clipboard
OLD_CLIP=$(pbpaste 2>/dev/null || true)
echo -n 'https://google.com' | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.1
echo -n "$OLD_CLIP" | pbcopy 2>/dev/null || true

# Press Enter
osascript -e 'tell application "System Events" to key code 36'
sleep 1.0
echo "Navigation completed."
```

### Example 5: Full Automation — Screenshot, Analyze, Click

Input: "Find and click the blue button on screen"

```bash
# Step 1: Screenshot
screencapture -x /tmp/screen.png
echo "Screenshot saved to /tmp/screen.png"

# Step 2: Agent reads /tmp/screen.png with Read tool to analyze
# (Agent identifies blue button at pixel coordinates, e.g., 800x400)

# Step 3: Convert Retina coordinates and click
python3 << 'PYEOF'
import ctypes, ctypes.util
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
# Pixel coords 800,400 → logical coords 400,200 on Retina
x, y = 400, 200
event = cg.CGEventCreateMouseEvent(None, 1, (x, y), 0)
cg.CGEventPost(0, event)
cg.CFRelease(event)
event = cg.CGEventCreateMouseEvent(None, 2, (x, y), 0)
cg.CGEventPost(0, event)
cg.CFRelease(event)
PYEOF

sleep 0.3
screencapture -x /tmp/screen_after.png
echo "Action completed. Verify with /tmp/screen_after.png"
```

## DO NOT

- ❌ Install third-party tools like `cliclick` — use native commands
- ❌ Use `osascript keystroke` for CJK text — use clipboard paste instead
- ❌ Attempt to bypass macOS security dialogs or permissions
- ❌ Run on non-macOS systems
- ❌ Perform rapid repeated actions without verification screenshots
- ❌ Access sensitive applications (Keychain, 1Password, etc.) without explicit user consent
- ❌ Store screenshots containing sensitive information permanently — use /tmp and clean up

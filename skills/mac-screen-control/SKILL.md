---
name: mac-screen-control
description: macOS screen/keyboard/mouse control via Accessibility API and CGEvent. Use when user wants to control desktop applications, automate UI interactions, take screenshots, click elements, type text (including Chinese), or manage windows on macOS. Triggers on keywords like "Mac控制", "屏幕控制", "桌面自动化", "Mac automation", "screen control", "click element", "type text".
allowed-tools: [Read, Write, Bash]
---

# Mac Screen Control

You control macOS desktop applications through **CGEvent** (hardware-level mouse/keyboard events) and **osascript** (window management). This enables automating UI interactions across any application.

> **Platform**: macOS only. Verify with `uname -s` — must return `Darwin`.
> **Permission**: System Settings > Privacy & Security > Accessibility must grant access to the terminal/agent process.

## Workflow

Every interaction follows this loop:

```
screenshot → analyze → locate → act → verify
```

1. Take a screenshot to see the current screen state
2. Analyze the image to identify target elements and coordinates
3. Perform the action (click, type, drag, etc.)
4. Take another screenshot to verify the result

## Capabilities

### 1. Screenshot

```bash
# Full screen screenshot to file
screencapture -x /tmp/screenshot.png

# Specific region (x,y,width,height in logical points)
screencapture -R "${x},${y},${width},${height}" -x /tmp/screenshot.png

# Specific window (interactive — click the window)
screencapture -i -o -x /tmp/screenshot.png
```

After capture, use the Read tool to view the image and analyze UI elements.

### 2. Mouse Control via CGEvent (Python)

All coordinates are in **logical points** (not pixels). If you have pixel coordinates from a Retina screenshot, divide by `backingScaleFactor` (typically 2.0).

```python
# Click at (x, y) in logical points
python3 -c "
import subprocess, sys
x, y = float(sys.argv[1]), float(sys.argv[2])

# Move mouse
subprocess.run(['python3', '-c', f'''
import ctypes, ctypes.util
app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library(\"AppKit\"))
app_kit.NSApplicationLoad()

cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library(\"CoreGraphics\"))

# CGEventCreateMouseEvent(source, type, point, button)
# type: 5=move, 1=left_down, 2=left_up, 3=right_down, 4=right_up
# point: (x << 16) | 0, (y << 16) | 0 (fixed-point 16.16)

point = ctypes.c_void_p((int(x) << 16) | 0)
point2 = ctypes.c_void_p((int(y) << 16) | 0)
event = cg.CGEventCreateMouseEvent(None, 5, point, 0)  # move
cg.CGEventPost(0, event)  # 0=HID, 1=session, 2=ansi

import time; time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 1, point, 0)  # left down
cg.CGEventPost(0, event)
import time; time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 2, point, 0)  # left up
cg.CGEventPost(0, event)
'''])
" -- "$X" "$Y"
```

For convenience, use these helper functions:

#### Left Click

```bash
python3 << 'PYEOF'
import ctypes, ctypes.util, time

def click(x, y, button='left'):
    cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
    app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))
    app_kit.NSApplicationLoad()

    pt_x = ctypes.c_void_p((int(x) << 16))
    pt_y = ctypes.c_void_p((int(y) << 16))

    down = 1 if button == 'left' else 3
    up = 2 if button == 'left' else 4

    for etype in [5, down]:  # move, then press
        event = cg.CGEventCreateMouseEvent(None, etype, pt_x, 0 if button == 'left' else 1)
        cg.CGEventPost(0, event)
        time.sleep(0.02)
    time.sleep(0.05)
    event = cg.CGEventCreateMouseEvent(None, up, pt_x, 0 if button == 'left' else 1)
    cg.CGEventPost(0, event)

click(X_COORD, Y_COORD)  # Replace with actual coordinates
PYEOF
```

#### Double Click

```bash
python3 << 'PYEOF'
import ctypes, ctypes.util, time

def double_click(x, y):
    cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
    app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))
    app_kit.NSApplicationLoad()

    pt_x = ctypes.c_void_p((int(x) << 16))
    pt_y = ctypes.c_void_p((int(y) << 16))

    for _ in range(2):
        event = cg.CGEventCreateMouseEvent(None, 1, pt_x, 0)
        cg.CGEventPost(0, event)
        time.sleep(0.02)
        event = cg.CGEventCreateMouseEvent(None, 2, pt_x, 0)
        cg.CGEventPost(0, event)
        time.sleep(0.05)

double_click(X_COORD, Y_COORD)
PYEOF
```

#### Right Click

Same as left click but with `button='right'` (down=3, up=4, button=1).

#### Drag

```bash
python3 << 'PYEOF'
import ctypes, ctypes.util, time

def drag(x1, y1, x2, y2, duration=0.5):
    cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
    app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))
    app_kit.NSApplicationLoad()

    steps = 20
    for i in range(steps + 1):
        t = i / steps
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t
        pt_x = ctypes.c_void_p((int(cx) << 16))
        pt_y = ctypes.c_void_p((int(cy) << 16))

        if i == 0:
            event = cg.CGEventCreateMouseEvent(None, 1, pt_x, 0)  # left down
            cg.CGEventPost(0, event)
        event = cg.CGEventCreateMouseEvent(None, 5, pt_x, 0)  # drag
        event = cg.CGEventCreateMouseEvent(None, 6, pt_x, 0)  # left drag
        cg.CGEventPost(0, event)
        time.sleep(duration / steps)

    pt_x = ctypes.c_void_p((int(x2) << 16))
    event = cg.CGEventCreateMouseEvent(None, 2, pt_x, 0)  # left up
    cg.CGEventPost(0, event)

drag(X1, Y1, X2, Y2)
PYEOF
```

### 3. Text Input (Chinese & CJK Support)

For typing text including Chinese, Japanese, Korean, emoji, and special characters, **always use the clipboard approach**. CGEvent Unicode injection (`CGEventKeyboardSetUnicodeString`) only handles single characters and breaks with composed sequences.

```bash
# Type text via clipboard (handles CJK, emoji, everything)
type_text() {
    local text="$1"
    # Save current clipboard
    local saved_clipboard
    saved_clipboard=$(pbpaste 2>/dev/null || true)
    # Write text to clipboard
    echo -n "$text" | pbcopy
    # Small delay to ensure clipboard is updated
    sleep 0.1
    # Simulate Cmd+V
    osascript -e 'tell application "System Events" to keystroke "v" using command down'
    # Restore original clipboard after a delay
    (sleep 0.5 && echo -n "$saved_clipboard" | pbcopy) &

    # Wait for paste to complete
    sleep 0.3
}

# Usage:
type_text "你好世界 Hello World 🎉"
```

For pressing individual keys or shortcuts:

```bash
# Key press with modifiers
osascript -e 'tell application "System Events" to keystroke "a" using {command down}'

# Key code (e.g., Return=36, Tab=48, Escape=53, Delete=51)
osascript -e 'tell application "System Events" to key code 36'

# Multiple modifiers
osascript -e 'tell application "System Events" to keystroke "f" using {command down, shift down}'
```

**Common key codes**:
| Key | Code | Key | Code |
|-----|------|-----|------|
| Return | 36 | Tab | 48 |
| Escape | 53 | Delete | 51 |
| Space | 49 | Left | 123 |
| Right | 124 | Up | 126 |
| Down | 125 | Home | 115 |
| End | 119 | PageUp | 116 |
| PageDown | 121 | F1-F12 | 122-135 |

### 4. Window Management

```bash
# Get window bounds (position and size)
osascript -e 'tell application "System Events" to tell process "APP_NAME" to get {position, size} of window 1'

# Bring app to front
osascript -e 'tell application "APP_NAME" to activate'

# Resize and reposition window
osascript -e 'tell application "System Events" to tell process "APP_NAME" to set {position, size} of window 1 to {{X, Y}, {W, H}}'

# List all windows of an app
osascript -e 'tell application "System Events" to tell process "APP_NAME" to get name of every window'

# Close window (Cmd+W)
osascript -e 'tell application "System Events" to keystroke "w" using command down'
```

### 5. UI Element Discovery (Accessibility API)

```bash
# List all UI elements of the frontmost window
osascript << 'EOF'
tell application "System Events"
    tell process "APP_NAME"
        get entire contents of window 1
    end tell
end tell
EOF

# Get specific element properties
osascript << 'EOF'
tell application "System Events"
    tell process "APP_NAME"
        -- Find buttons
        get name of every button of window 1
        -- Find text fields
        get name of every text field of window 1
        -- Find menus
        get name of every menu of menu bar 1
    end tell
end tell
EOF

# Click a menu item
osascript -e 'tell application "System Events" to tell process "APP_NAME" to click menu item "MENU_ITEM" of menu "MENU_NAME" of menu bar 1'
```

> **Note for Electron apps**: CGEvent is more reliable than AX for clicks and typing. For reading UI state, check if AX works first by querying `AXUIElementCopyAttributeValue` with `kAXChildrenAttribute`.

### 6. Coordinate Calibration

```bash
# Get the display scale factor (2.0 for Retina, 1.0 for standard)
system_profiler SPDisplaysDataType | grep Resolution

# Rule: screencapture coordinates are in logical points
# If an image analysis tool gives pixel coordinates on a Retina display:
# logical_x = pixel_x / 2.0
# logical_y = pixel_y / 2.0
```

## Common Patterns

### Pattern: Click a Button by Position

```bash
# 1. Screenshot
screencapture -x /tmp/screen.png

# 2. Read and analyze the image (using Read tool on /tmp/screen.png)
# Identify the button's center coordinates in logical points

# 3. Click
python3 << 'PYEOF'
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))
app_kit.NSApplicationLoad()
x, y = X_COORD, Y_COORD  # Replace with identified coordinates
pt = ctypes.c_void_p((int(x) << 16))
for etype in [5, 1]:  # move, left_down
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, etype, pt, 0))
    time.sleep(0.02)
time.sleep(0.05)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, pt, 0))  # left_up
PYEOF

# 4. Verify with another screenshot
screencapture -x /tmp/screen_after.png
```

### Pattern: Type Text into a Focused Field

```bash
# 1. Click on the text field to focus it
# (see click pattern above)

# 2. Clear existing text (Cmd+A then Delete)
osascript -e 'tell application "System Events" to keystroke "a" using command down'
sleep 0.1
osascript -e 'tell application "System Events" to key code 51'

# 3. Type via clipboard
echo -n "Your text here 你好世界" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
```

### Pattern: Open App and Navigate

```bash
# 1. Open/activate the application
open -a "Feishu"  # or: osascript -e 'tell application "Feishu" to activate'
sleep 1

# 2. Take screenshot to see current state
screencapture -x /tmp/screen.png

# 3. Navigate via keyboard shortcuts or click elements
# ...
```

### Pattern: Find and Click by Accessibility

```bash
# 1. Get the button names
osascript -e 'tell application "System Events" to tell process "APP_NAME" to get name of every button of window 1'

# 2. Click a specific button by name
osascript -e 'tell application "System Events" to tell process "APP_NAME" to click button "Button Name" of window 1'
```

## Important Notes

1. **Always verify with a screenshot** after performing actions to confirm the result
2. **Use logical points** (not pixels) for all CGEvent coordinates
3. **Clipboard method for CJK text** — never use `keystroke` for non-ASCII characters
4. **Electron apps**: prefer CGEvent over AX for clicks; AX may work for reading state
5. **Save and restore clipboard** when using the paste method to be non-destructive
6. **Add small delays** (50-100ms) between actions to allow the UI to update
7. **Skip cliclick** — CGEvent via Python ctypes is zero-dependency and more capable
8. **Multi-monitor**: coordinates span across monitors; check window position first

## Error Handling

- If `CGEvent` calls fail, the agent likely lacks Accessibility permission. Guide the user to System Settings > Privacy & Security > Accessibility.
- If `osascript` returns "not allowed", the app needs Automation permission in System Settings > Privacy & Security > Automation.
- If screenshots are blank, check Screen Recording permission in System Settings > Privacy & Security > Screen Recording.

## Related

- Issue #2216 (Mac 屏幕控制能力 - 辅助功能自动化模块)

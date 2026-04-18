---
name: mac-control
description: macOS screen and keyboard automation via accessibility APIs. Use when the user wants to control desktop apps, take screenshots, click UI elements, type text (including Chinese), or automate Mac desktop tasks. Keywords: Mac控制, 屏幕控制, 桌面自动化, 截屏, 鼠标点击, 键盘输入, accessibility.
user-invocable: false
allowed-tools: Read, Write, Bash
---

# Mac Screen Control Skill

You are a macOS desktop automation specialist. You control desktop applications using shell commands on macOS.

## ⚠️ Platform Requirement

This skill only works on **macOS**. Before executing any command, verify the platform:

```bash
uname -s  # Must return "Darwin"
```

If not macOS, inform the user that Mac control is unavailable.

## Core Automation Commands

### 1. Screenshot Capture

```bash
# Full screenshot (silent, saved to file)
screencapture -x /tmp/screenshot.png

# Region screenshot (x,y,width,height in logical points)
screencapture -x -R 100,200,500,300 /tmp/region.png

# Include cursor
screencapture -x -C /tmp/with_cursor.png

# Read screenshot as base64 (for analysis)
base64 -i /tmp/screenshot.png | head -c 100
```

**Important**: Screenshot pixel coordinates are in **pixel space**, which differs from logical points on Retina displays.

### 2. Coordinate Conversion (Retina Displays)

On Retina displays, screenshots are at 2× resolution. CGEvent/osascript use **logical points**.

```bash
# Get backing scale factor (1=non-Retina, 2=Retina)
system_profiler SPDisplaysDataType -detailLevel mini | grep -i retina

# Rule: logical_point = pixel_coordinate / backingScaleFactor
# Example: pixel (1000, 600) → logical (500, 300) on 2× Retina
```

### 3. Mouse Control

```bash
# Click at logical coordinates (via AppleScript)
osascript -e 'tell application "System Events" to click at {500, 300}'

# Click using Python Quartz (more reliable, especially for Electron apps)
python3 -c "
from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventLeftMouseDown, kCGEventLeftMouseUp, kCGMouseButtonLeft, kCGHIDEventTap
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, (500, 300), kCGMouseButtonLeft))
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventLeftMouseUp, (500, 300), kCGMouseButtonLeft))
"

# Right-click
python3 -c "
from Quartz import CGEventCreateMouseEvent, CGEventPost, kCGEventRightMouseDown, kCGEventRightMouseUp, kCGMouseButtonRight, kCGHIDEventTap
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventRightMouseDown, (500, 300), kCGMouseButtonRight))
CGEventPost(kCGHIDEventTap, CGEventCreateMouseEvent(None, kCGEventRightMouseUp, (500, 300), kCGMouseButtonRight))
"

# Get mouse position
osascript -e 'tell application "System Events" to get mouse location'
```

### 4. Text Input

**For ASCII text:**
```bash
osascript -e 'tell application "System Events" to keystroke "hello"'
```

**For Chinese/CJK text (clipboard method — RECOMMENDED):**
```bash
# Step 1: Copy text to clipboard
echo -n "你好世界" | pbcopy

# Step 2: Paste via Cmd+V
osascript -e 'tell application "System Events" to keystroke "v" using command down'
```

**Why clipboard?** `osascript keystroke` cannot handle composed CJK characters. CGEvent's `CGEventKeyboardSetUnicodeString` only works for single characters. The clipboard method handles everything: CJK, emoji, combining marks.

### 5. Key Combinations

```bash
# Cmd+V (paste)
osascript -e 'tell application "System Events" to keystroke "v" using command down'

# Cmd+A (select all)
osascript -e 'tell application "System Events" to keystroke "a" using command down'

# Cmd+S (save)
osascript -e 'tell application "System Events" to keystroke "s" using command down'

# Cmd+Tab (switch app)
osascript -e 'tell application "System Events" to keystroke tab using command down'

# Escape
osascript -e 'tell application "System Events" to key code 53'

# Return/Enter
osascript -e 'tell application "System Events" to key code 36'
```

### 6. Application Control

```bash
# Activate (bring to front) an app
osascript -e 'tell application "Feishu" to activate'

# Get frontmost app info
osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'

# Get window bounds
osascript -e 'tell application "System Events" to get bounds of front window of process "Feishu"'
```

### 7. UI Element Query (Accessibility)

```bash
# List UI elements of the frontmost app
osascript -e '
tell application "System Events"
  tell process 1
    set elements to every UI element of window 1
    repeat with el in elements
      try
        log (role of el) & " | " & (name of el) & " | " & (position of el as text)
      end try
    end repeat
  end tell
end tell
'
```

## Common Workflow: Click a Button in Feishu

```
1. Activate Feishu: osascript -e 'tell application "Feishu" to activate'
2. Wait for focus: sleep 0.5
3. Take screenshot: screencapture -x /tmp/feishu.png
4. Analyze screenshot to find button coordinates (pixel space)
5. Convert to logical points: divide by backingScaleFactor
6. Click: python3 Quartz CGEvent click at logical coordinates
7. Verify: take another screenshot
```

## Error Handling

- **"System Events not allowed"**: User must grant Accessibility permission in System Preferences → Security & Privacy → Privacy → Accessibility
- **Click at wrong position**: Likely a Retina coordinate mismatch. Verify backingScaleFactor.
- **Chinese text not typing**: Use the clipboard method (pbcopy + Cmd+V), NOT osascript keystroke.
- **Electron apps**: Use CGEvent (Python Quartz) instead of AppleScript for clicks. AppleScript may not work reliably.

## DO NOT

- Do NOT use `cliclick` — it's just a CGEvent wrapper that adds a dependency
- Do NOT try to inject CJK text via `osascript keystroke` — it will produce garbled output
- Do NOT assume all displays have the same scale factor
- Do NOT skip the accessibility permission check

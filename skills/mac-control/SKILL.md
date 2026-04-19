---
name: mac-control
description: macOS screen/keyboard/mouse control via Accessibility APIs. Use when user needs to automate desktop apps, take screenshots, click UI elements, type text (including CJK), or manage windows on macOS. Keywords: mac, screen, click, type, screenshot, automation, desktop, 飞书, Feishu, 屏幕控制, 鼠标, 键盘, 自动化.
disable-model-invocation: true
allowed-tools: Bash, Read, Write
---

# Mac Screen Control Skill

Control macOS desktop applications via native CLI tools and Accessibility APIs.

> **Platform Requirement**: This skill only works on **macOS** with accessibility permissions granted.
> Remote servers without a GUI are NOT supported.

## Prerequisites Check

Before using any command, verify the environment:

```bash
# 1. Check macOS
[[ "$(uname)" == "Darwin" ]] || { echo "ERROR: Not macOS"; exit 1; }

# 2. Check accessibility permission (for osascript UI automation)
osascript -e 'tell application "System Events" to get name of first process' 2>/dev/null \
  || echo "WARNING: Accessibility permission not granted. Go to System Settings > Privacy & Security > Accessibility."

# 3. Check optional tools
command -v cliclick &>/dev/null && echo "cliclick: OK" || echo "cliclick: not installed (brew install cliclick)"
```

## Commands Reference

### 1. Screenshot

```bash
# Full screen screenshot → save to temp file
screenshot_path="/tmp/mac-screenshot-$(date +%s).png"
screencapture -x "$screenshot_path"
echo "Saved: $screenshot_path"

# Region screenshot (x,y,width,height)
screencapture -R 100,200,800,600 -x "$screenshot_path"

# Specific window screenshot (interactive - click to select)
screencapture -i -w -x "$screenshot_path"
```

### 2. Mouse Control

Uses `cliclick` (recommended) or `osascript` as fallback.

```bash
# --- Using cliclick (recommended) ---

# Left click at coordinates (x, y)
cliclick c:500,300

# Double click
cliclick dc:500,300

# Right click
cliclick rc:500,300

# Move mouse without clicking
cliclick m:500,300

# Click and drag from (100,200) to (500,300)
cliclick md:100,200  # mouse down
cliclick m:300,250   # move to midpoint
cliclick mu:500,300  # mouse up

# --- Using osascript (fallback, no cliclick needed) ---

# Left click at (x, y)
osascript -e "tell application \"System Events\" to set {x, y} to {500, 300}" \
  -e "do shell script \"python3 -c \\\"import ctypes; from AppKit import NSEvent; ctypes.pythonapi.PyTuple_SetItem.restype = None; \\\"\"" \
  2>/dev/null || echo "cliclick recommended for reliable mouse control"

# Simple AppleScript click (uses CGEvent via python3)
python3 -c "
import subprocess, time
subprocess.run(['cliclick', 'c:500,300'])
"
```

### 3. Keyboard / Text Input

**For ASCII text**: direct key simulation.
**For CJK/Unicode text**: clipboard paste method (recommended).

```bash
# --- ASCII text typing ---
# Using cliclick
cliclick t:Hello World

# Using osascript
osascript -e 'tell application "System Events" to keystroke "Hello World"'

# --- CJK / Unicode text (clipboard paste method) ---
# Step 1: Save current clipboard
old_clipboard=$(pbpaste 2>/dev/null || true)

# Step 2: Put text on clipboard
echo -n "中文文本内容" | pbcopy

# Step 3: Simulate Cmd+V paste
osascript -e 'tell application "System Events" to keystroke "v" using command down'

# Step 4: Wait for paste to complete
sleep 0.3

# Step 5: Restore original clipboard (optional, non-destructive)
echo -n "$old_clipboard" | pbcopy

# --- Key combinations ---
# Cmd+Enter
osascript -e 'tell application "System Events" to key code 36 using command down'

# Cmd+A (Select All)
osascript -e 'tell application "System Events" to keystroke "a" using command down'

# Cmd+C (Copy)
osascript -e 'tell application "System Events" to keystroke "c" using command down'

# Cmd+Tab (Switch app)
osascript -e 'tell application "System Events" to key code 48 using command down'

# Escape
osascript -e 'tell application "System Events" to key code 53'

# Return/Enter
osascript -e 'tell application "System Events" to key code 36'

# Tab
osascript -e 'tell application "System Events" to key code 48'

# Arrow keys
osascript -e 'tell application "System Events" to key code 124'  # Right
osascript -e 'tell application "System Events" to key code 123'  # Left
osascript -e 'tell application "System Events" to key code 126'  # Up
osascript -e 'tell application "System Events" to key code 125'  # Down
```

### 4. Window Management

```bash
# Get window bounds of an application
osascript -e '
tell application "System Events"
  tell process "Feishu"
    set windowList to every window
    repeat with w in windowList
      set b to bounds of w
      log "Window: " & name of w & " | Bounds: " & (item 1 of b as text) & "," & (item 2 of b as text) & "," & (item 3 of b as text) & "," & (item 4 of b as text)
    end repeat
  end tell
end tell
' 2>&1

# Activate (bring to front) an application
osascript -e 'tell application "Feishu" to activate'

# Resize and position a window
osascript -e '
tell application "System Events"
  tell process "Feishu"
    set position of first window to {100, 100}
    set size of first window to {1200, 800}
  end tell
end tell
'

# Get list of running applications
osascript -e 'tell application "System Events" to get name of every process whose background only is false'
```

### 5. Coordinate Calibration (Retina)

On Retina displays, screenshot pixel coordinates differ from logical (click) coordinates.

```bash
# Auto-detect scale factor
scale_factor=$(python3 -c "
try:
    from AppKit import NSScreen
    print(NSScreen.mainScreen().backingScaleFactor())
except:
    print('2')  # Default Retina factor
" 2>/dev/null || echo "2")

echo "Scale factor: $scale_factor"

# Convert screenshot pixel coords → logical coords for clicking
# Formula: logical_x = pixel_x / scale_factor
#          logical_y = pixel_y / scale_factor

# Example: pixel (1200, 1600) on Retina (2x)
logical_x=$(( 1200 / scale_factor ))
logical_y=$(( 1600 / scale_factor ))
echo "Click at logical coords: $logical_x, $logical_y"
cliclick c:${logical_x},${logical_y}
```

### 6. UI Element Finding (Accessibility API)

```bash
# List all UI elements of the frontmost window of an app
osascript -e '
tell application "System Events"
  tell process "Feishu"
    set uiElements to entire contents of first window
    repeat with elem in uiElements
      try
        set elemRole to role of elem
        set elemName to name of elem
        set elemDesc to description of elem
        set elemPos to position of elem
        set elemSize to size of elem
        log elemRole & " | " & elemName & " | " & elemDesc & " | pos:" & (item 1 of elemPos as text) & "," & (item 2 of elemPos as text) & " | size:" & (item 1 of elemSize as text) & "x" & (item 2 of elemSize as text)
      end try
    end repeat
  end tell
end tell
' 2>&1

# Click a specific UI element by name
osascript -e '
tell application "System Events"
  tell process "Feishu"
    click UI element "Send" of first window
  end tell
end tell
'

# Get text from a text field
osascript -e '
tell application "System Events"
  tell process "Feishu"
    set fieldValue to value of text field 1 of first window
    log fieldValue
  end tell
end tell
' 2>&1
```

## Common Workflows

### Workflow: Click a UI Element by Visual Position

```bash
# 1. Take screenshot
screenshot_path="/tmp/mac-screenshot-$(date +%s).png"
screencapture -x "$screenshot_path"

# 2. Analyze screenshot to find target coordinates (done by AI agent)
# Agent identifies pixel coords from the image, e.g., (1234, 567)

# 3. Convert Retina pixel coords to logical coords
scale=2  # typical Retina factor
logical_x=$(( 1234 / scale ))
logical_y=$(( 567 / scale ))

# 4. Click
cliclick c:${logical_x},${logical_y}

# 5. Verify by taking another screenshot
sleep 0.5
screencapture -x "/tmp/mac-verify-$(date +%s).png"
```

### Workflow: Send Message in Feishu

```bash
app_name="Feishu"

# 1. Activate Feishu
osascript -e "tell application \"$app_name\" to activate"
sleep 0.5

# 2. Find and click the message input area (visual or Accessibility)
# Option A: Using Accessibility API
osascript -e "
tell application \"System Events\"
  tell process \"$app_name\"
    -- Navigate to input field via keyboard
    keystroke \"\" -- focus input
  end tell
end tell"

# 3. Type message (CJK supported via clipboard)
message="你好，这是一条测试消息"
old_clipboard=$(pbpaste 2>/dev/null || true)
echo -n "$message" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.3
echo -n "$old_clipboard" | pbcopy

# 4. Send (Cmd+Enter or Enter depending on app)
osascript -e 'tell application "System Events" to key code 36'  # Enter
```

### Workflow: Switch to Specific Chat

```bash
# 1. Activate Feishu
osascript -e 'tell application "Feishu" to activate'
sleep 0.5

# 2. Open search (Cmd+K)
osascript -e 'tell application "System Events" to keystroke "k" using command down'
sleep 0.5

# 3. Type search query
query="目标群聊名称"
old_clipboard=$(pbpaste 2>/dev/null || true)
echo -n "$query" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
sleep 0.3
echo -n "$old_clipboard" | pbcopy

# 4. Wait for results and press Enter to select first result
sleep 1.0
osascript -e 'tell application "System Events" to key code 36'
```

## Helper Scripts

The `scripts/` directory contains reusable shell functions:

| Script | Purpose |
|--------|---------|
| `mac-clipboard-type.sh` | Type CJK/Unicode text via clipboard paste |
| `mac-screenshot.sh` | Screenshot with region and auto-calibration |

Use them from skill instructions:

```bash
# Type CJK text
bash "$(dirname "$0")/scripts/mac-clipboard-type.sh" "中文文本"

# Take screenshot with auto-naming
bash "$(dirname "$0")/scripts/mac-screenshot.sh" [--region x,y,w,h]
```

## Key Code Reference

Common key codes for `osascript`:

| Key | Code | Key | Code |
|-----|------|-----|------|
| Return | 36 | Tab | 48 |
| Escape | 53 | Space | 49 |
| Delete | 51 | Forward Delete | 117 |
| Left | 123 | Right | 124 |
| Down | 125 | Up | 126 |
| Home | 115 | End | 119 |
| Page Up | 116 | Page Down | 121 |
| F1 | 122 | F12 | 111 |
| Cmd | `command down` | Shift | `shift down` |
| Option | `option down` | Control | `control down` |

## Troubleshooting

### "osascript is not allowed to send keystrokes"
→ Go to **System Settings > Privacy & Security > Accessibility** and add Terminal (or your terminal app) to the allowed list.

### Click position is off
→ Likely Retina scaling issue. Use the coordinate calibration section above to convert between pixel and logical coordinates.

### Chinese text input is garbled
→ Use the **clipboard paste method** instead of direct key injection. `osascript keystroke` does not support CJK characters.

### cliclick not found
→ Install with `brew install cliclick`, or use osascript as fallback (with limitations).

## Limitations

- **macOS only** — requires native CLI tools (screencapture, osascript, pbcopy)
- **Accessibility permissions required** — must be granted to the terminal/agent process
- **No headless mode** — requires an active GUI session
- **Electron apps** — Accessibility API may be limited; prefer CGEvent (via cliclick) for clicks
- **Multi-monitor** — coordinate space extends across monitors; account for offsets

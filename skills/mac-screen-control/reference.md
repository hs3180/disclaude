# Mac Screen Control - Technical Reference

## Coordinate Systems

### macOS Display Coordinate Spaces

| Space | Used By | Unit | Origin |
|-------|---------|------|--------|
| **Logical Points** | cliclick, CGEvent, osascript | Points | Top-left of main display |
| **Pixel Coordinates** | screencapture, screenshots | Pixels | Top-left of main display |
| **AppKit Coordinates** | Cocoa apps | Points | Bottom-left of window |

### Retina Scaling

On Retina displays, the backing scale factor is 2x:

```
Pixel Coordinate = Logical Point x scaleFactor
```

Example:
- Screenshot shows button at pixel (1000, 600)
- cliclick needs logical point: (500, 300)

### Getting Scale Factor

```bash
# Method 1: system_profiler
system_profiler SPDisplaysDataType | grep "Retina"

# Method 2: AppKit (more accurate)
osascript -e '
    use framework "AppKit"
    set mainScreen to current application'\''s NSScreen'\''s mainScreen()
    set scaleFactor to mainScreen'\''s backingScaleFactor()
    return scaleFactor as text
'

# Method 3: Quartz (works from command line)
python3 -c "
import Quartz
mainDisplay = Quartz.CGMainDisplayID()
scale = Quartz.CGDisplayPixelsWide(mainDisplay) / Quartz.CGDisplayModeGetWidth(Quartz.CGDisplayCopyDisplayMode(mainDisplay))
print(int(scale))
"
```

## Text Input Methods

### Method Comparison

| Method | ASCII | CJK | IME Issues | Complexity |
|--------|-------|-----|------------|------------|
| `cliclick t:` | Good | BROKEN | N/A | Low |
| `osascript keystroke` | Good | BROKEN | Severe | Low |
| **pbcopy + Cmd+V** | Good | **Good** | None | Low |
| CGEvent Unicode | Good | Partial | Moderate | High |

### Clipboard Paste Method (Recommended for all text)

```bash
# Save old clipboard
old_clipboard=$(pbpaste 2>/dev/null || true)

# Copy text and paste
echo -n "Your text here 任意中文" | pbcopy
sleep 0.1
cliclick kp:cmd,v
sleep 0.2

# Restore clipboard
echo -n "$old_clipboard" | pbcopy 2>/dev/null || true
```

### Why Not osascript keystroke?

`osascript keystroke` sends individual key events. With Chinese input method active:
- Each keystroke is intercepted by the IME
- "Mathlab" becomes "Math 爱爱吧" (IME converts phonetic keys)
- The result is unpredictable and depends on IME state

## CGEvent (Advanced)

For advanced use cases, CGEvent provides hardware-level event injection.

### Python CGEvent via pyobjc

```python
#!/usr/bin/env python3
"""Low-level CGEvent mouse/keyboard control."""
import Quartz

def click(x, y, button=Quartz.kCGMouseButtonLeft):
    """Click at logical coordinates."""
    # Mouse down
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventMouseButtonDown,
        (x, y), button
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    # Mouse up
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventMouseButtonUp,
        (x, y), button
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

def type_unicode(text):
    """Type Unicode text via CGEvent (limited CJK support)."""
    for char in text:
        event = Quartz.CGEventCreateKeyboardEvent(None, 0, True)
        Quartz.CGEventKeyboardSetUnicodeString(event, len(char), char)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
        event = Quartz.CGEventCreateKeyboardEvent(None, 0, False)
        Quartz.CGEventKeyboardSetUnicodeString(event, len(char), char)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
```

### Why CGEvent over cliclick?

- **Zero dependencies** (no brew install needed)
- **Direct hardware events** - all apps respond
- **Programmatic control** - easier to add timing/delays
- **But**: Requires pyobjc or ctypes bindings

## Accessibility API (AXUIElement)

### Reading UI Elements

```bash
# Get full UI tree of an application window
osascript -e '
tell application "System Events"
    tell process "Safari"
        set uiTree to entire contents of front window
        repeat with elem in uiTree
            try
                set elemInfo to {role of elem, name of elem, position of elem, size of elem}
                log elemInfo
            end try
        end repeat
    end tell
end tell
'

# Find specific element by name
osascript -e '
tell application "System Events"
    tell process "Finder"
        set btns to every button of front window whose name is "OK"
        if (count of btns) > 0 then
            click item 1 of btns
        end if
    end tell
end tell
'
```

### Electron App Limitations

Electron apps may have incomplete accessibility trees:

| Feature | Native App | Electron App |
|---------|-----------|--------------|
| Button names | Available | Usually available |
| Text content | Available | May be empty |
| Click via AX | Works | May not work |
| Click via CGEvent | Works | **Works** |

**Recommendation**: For Electron apps (Feishu, VS Code, etc.), prefer CGEvent clicks over AX clicks.

## Multi-Monitor Handling

```bash
# Get all display information
system_profiler SPDisplaysDataType

# Get display arrangement (Quartz)
python3 -c "
import Quartz
for i in range(Quartz.CGGetOnlineDisplayList(10, None, None)):
    display = Quartz.CGGetOnlineDisplayList(10, None, None)
    if display:
        for d in display[0]:
            rect = Quartz.CGDisplayBounds(d)
            print(f'Display {d}: origin=({rect.origin.x},{rect.origin.y}), size={rect.size.width}x{rect.size.height}')
"

# Screenshots include all displays
# Coordinate space extends across all monitors
# Main display origin is (0,0)
# Secondary displays have offsets based on arrangement
```

## Common Application Interactions

### Feishu (飞书/Lark)

```bash
# App name can be "Lark" or "Feishu" depending on locale
osascript -e 'tell application "Lark" to activate'

# Note: Feishu is an Electron app
# - Prefer CGEvent/cliclick over AX for clicks
# - Use clipboard method for Chinese text input
# - Sidebar is typically on the left ~200px wide
# - Chat input box is typically near bottom of window
```

### Finder

```bash
osascript -e 'tell application "Finder" to activate'
# AX API works well with Finder (native Cocoa app)
# Can use both AX clicks and CGEvent clicks
```

### Safari / Chrome

```bash
# Both work well with AX API for reading elements
# CGEvent for clicking is more reliable for all elements
osascript -e 'tell application "Safari" to activate'
osascript -e 'tell application "Google Chrome" to activate'
```

## Security and Permissions

### Required Permissions

| Permission | Purpose | How to Grant |
|-----------|---------|-------------|
| **Accessibility** | CGEvent, AX API, System Events | System Settings > Privacy & Security > Accessibility |
| **Screen Recording** | Screenshots of other apps | System Settings > Privacy & Security > Screen Recording |
| **Automation** | osascript control of apps | Popup dialog on first use |

### Permission Detection

```bash
# Check accessibility (returns error if not granted)
osascript -e 'tell application "System Events" to get name of first process' 2>&1

# Check screen recording (screenshot returns blank if not granted)
screencapture -x /tmp/perm_test.png
# If the screenshot is all black, screen recording permission not granted
```

## Troubleshooting

### cliclick not found
```bash
brew install cliclick
```

### Click lands in wrong position
1. Check Retina scaling: `./scripts/mac-control.sh scale-factor`
2. Convert pixel coords: `./scripts/mac-control.sh pixel-to-logical 1000 600`
3. Always verify with a screenshot after clicking

### Chinese text appears garbled
1. Use `type-cjk` command (clipboard method), not `type`
2. Ensure no active IME conversion is pending
3. Try switching to English input first: `cliclick kp:cmd,space`

### Application not responding to clicks
1. Verify app is active: `./scripts/mac-control.sh activate "AppName"`
2. For Electron apps, use cliclick (CGEvent) not AX
3. Add delay between operations: `./scripts/mac-control.sh wait 0.5`

### osascript permission dialog
1. First run triggers permission dialog
2. User must click "Allow" or "OK"
3. Can be pre-granted in System Settings

## References

- [AppleScript CLI Guide (steipete.me, 2025)](https://steipete.me/posts/2025/applescript-cli-macos-complete-guide)
- [openclaw mac-control Skill](https://github.com/openclaw/skills/tree/main/skills/easonc13/mac-control/SKILL.md)
- [openclaw macos-native-automation Skill](https://github.com/openclaw/skills/tree/main/skills/theagentwire/macos-native-automation/SKILL.md)
- [mcp-server-macos-use (mediar-ai)](https://github.com/mediar-ai/mcp-server-macos-use)
- [Auto-Type on macOS (kulman.sk, 2025)](https://blog.kulman.sk/implementing-auto-type-on-macos/)

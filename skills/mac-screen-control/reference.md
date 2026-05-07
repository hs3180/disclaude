# Mac Screen Control - Technical Reference

## Coordinate Systems

### macOS Display Coordinate Spaces

| Space | Used By | Unit | Origin |
|-------|---------|------|--------|
| **Logical Points** | CGEvent, osascript | Points | Top-left of main display |
| **Pixel Coordinates** | screencapture, screenshots | Pixels | Top-left of main display |
| **AppKit Coordinates** | Cocoa apps | Points | Bottom-left of window |

### Retina Scaling

On Retina displays, the backing scale factor is 2x:

```
Pixel Coordinate = Logical Point x scaleFactor
```

Example:
- Screenshot shows button at pixel (1000, 600)
- CGEvent needs logical point: (500, 300)

### Getting Scale Factor

```bash
# Method 1: CGEvent via Python ctypes (recommended)
python3 -c "
import ctypes, ctypes.util
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
main_id = cg.CGMainDisplayID()
width_px = cg.CGDisplayPixelsWide(main_id)
mode = cg.CGDisplayCopyDisplayMode(main_id)
mode_w = cg.CGDisplayModeGetWidth(mode)
print(int(width_px / mode_w))
"

# Method 2: AppKit via osascript
osascript -e '
    use framework "AppKit"
    set mainScreen to current application'\''s NSScreen'\''s mainScreen()
    set scaleFactor to mainScreen'\''s backingScaleFactor()
    return scaleFactor as text
'
```

## Text Input Methods

### Method Comparison

| Method | ASCII | CJK | IME Issues | External Deps |
|--------|-------|-----|------------|---------------|
| cliclick t: | Good | BROKEN | N/A | Yes (brew) |
| osascript keystroke | Good | BROKEN | Severe | No |
| **pbcopy + Cmd+V** | Good | **Good** | None | No |
| CGEvent Unicode | Good | Partial | Moderate | No |

### Clipboard Paste Method (Recommended for all text)

```bash
# Save old clipboard
old_clipboard=$(pbpaste 2>/dev/null || true)
# Copy text and paste via CGEvent Cmd+V
echo -n "Your text here" | pbcopy
sleep 0.1
python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, 55, True))
time.sleep(0.02)
v = cg.CGEventCreateKeyboardEvent(None, 9, True)
cg.CGEventSetFlags(v, 0x001000)
cg.CGEventPost(0, v)
time.sleep(0.02)
v = cg.CGEventCreateKeyboardEvent(None, 9, False)
cg.CGEventSetFlags(v, 0x001000)
cg.CGEventPost(0, v)
time.sleep(0.02)
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, 55, False))
"
sleep 0.2
# Restore clipboard
echo -n "$old_clipboard" | pbcopy 2>/dev/null || true
```

## CGEvent Key Constants

```python
# Mouse event types
kCGEventMouseButtonDown = 1
kCGEventMouseButtonUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventMouseMoved = 5
kCGEventLeftMouseDragged = 6

# Modifier flags
kCGEventFlagMaskCommand = 0x001000
kCGEventFlagMaskShift = 0x002000
kCGEventFlagMaskControl = 0x040000
kCGEventFlagMaskAlternate = 0x080000
```

### Keycode Reference

| Key | Keycode | Key | Keycode |
|-----|---------|-----|---------|
| A | 0 | C | 8 |
| V | 9 | X | 7 |
| Z | 6 | Return | 36 |
| Tab | 48 | Escape | 53 |
| Space | 49 | Delete | 51 |
| Left Arrow | 123 | Right Arrow | 124 |
| Up Arrow | 126 | Down Arrow | 125 |
| Cmd | 55 | Shift | 56 |
| Control | 59 | Option | 58 |

## Electron App Notes

Electron apps may have incomplete accessibility trees:

| Feature | Native App | Electron App |
|---------|-----------|--------------|
| Button names | Available | Usually available |
| Click via AX | Works | May not work |
| Click via CGEvent | Works | **Works** |

**Recommendation**: For Electron apps (Feishu, VS Code, etc.), prefer CGEvent clicks over AX clicks.

## Security and Permissions

| Permission | Purpose | How to Grant |
|-----------|---------|-------------|
| **Accessibility** | CGEvent, AX API | System Settings > Privacy > Accessibility |
| **Screen Recording** | Screenshots | System Settings > Privacy > Screen Recording |
| **Automation** | osascript | Popup dialog on first use |

## References

- [AppleScript CLI Guide (steipete.me, 2025)](https://steipete.me/posts/2025/applescript-cli-macos-complete-guide)
- [openclaw mac-control Skill](https://github.com/openclaw/skills/tree/main/skills/easonc13/mac-control/SKILL.md)
- [openclaw macos-native-automation Skill](https://github.com/openclaw/skills/tree/main/skills/theagentwire/macos-native-automation/SKILL.md)
- [mcp-server-macos-use (mediar-ai)](https://github.com/mediar-ai/mcp-server-macos-use)
- [terminator element interaction (mediar-ai)](https://github.com/mediar-ai/terminator/blob/main/crates/terminator/src/element.rs)
- [Auto-Type on macOS (kulman.sk, 2025)](https://blog.kulman.sk/implementing-auto-type-on-macos/)

# Mac Control — Technical Reference

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Claude Agent                          │
│                                                         │
│  Reads SKILL.md → knows how to use the tools below      │
└──────────────────┬──────────────────────────────────────┘
                   │ Bash tool
                   ▼
┌─────────────────────────────────────────────────────────┐
│                 Helper Scripts                           │
│                                                         │
│  scripts/mac-control.py   ← Mouse, Keyboard, Screenshot │
│  scripts/mac-window.sh    ← Window management           │
│  scripts/mac-calibrate.py ← Coordinate calibration      │
└──────────────────┬──────────────────────────────────────┘
                   │ System calls
                   ▼
┌─────────────────────────────────────────────────────────┐
│              macOS System APIs                           │
│                                                         │
│  CoreGraphics (CGEvent)   ← Mouse & Keyboard events     │
│  screencapture CLI        ← Screenshots                 │
│  AppleScript/osascript    ← Window management            │
│  pbcopy/pbpaste           ← Clipboard for CJK input     │
└─────────────────────────────────────────────────────────┘
```

## Coordinate System Details

### Retina Display Handling

macOS uses two coordinate systems:

| System | Used by | Unit |
|--------|---------|------|
| **Logical points** | CGEvent, AppleScript, window bounds | Points (1pt = 1/72 inch) |
| **Physical pixels** | Screenshots (PNG) | Pixels (2px per point on Retina) |

On a Retina display with `backingScaleFactor = 2`:
- A 1440×900 logical screen produces 2880×1800 pixel screenshots
- CGEvent click at (500, 300) corresponds to screenshot pixel (1000, 600)

### Conversion Formula

```python
scale_factor = 2  # From NSScreen.mainScreen().backingScaleFactor()

# Screenshot pixel → CGEvent logical point
logical_x = pixel_x / scale_factor
logical_y = pixel_y / scale_factor

# CGEvent logical point → Screenshot pixel
pixel_x = logical_x * scale_factor
pixel_y = logical_y * scale_factor
```

## CJK Text Input

### Problem
- `osascript keystroke` is intercepted by IME
- `cliclick t:` does not support non-ASCII characters
- CGEvent `CGEventKeyboardSetUnicodeString` only works for single characters and breaks with composed sequences

### Solution: Clipboard Paste Method
1. Save current clipboard: `pbpaste` → old_clipboard
2. Set clipboard to target text: `echo -n "中文" | pbcopy`
3. Simulate `Cmd+V`: CGEvent key_down(v, command) + key_up(v, command)
4. Restore original clipboard: `pbcopy` < old_clipboard

This handles CJK, emoji, combining marks, and all Unicode characters.

## Key Codes Reference

### Common Keys

| Key | Virtual Keycode |
|-----|----------------|
| Return/Enter | 0x24 |
| Tab | 0x30 |
| Space | 0x31 |
| Delete/Backspace | 0x33 |
| Escape | 0x35 |
| ↑ | 0x7E |
| ↓ | 0x7D |
| ← | 0x7B |
| → | 0x7C |
| Home | 0x73 |
| End | 0x77 |
| Page Up | 0x74 |
| Page Down | 0x79 |

### Modifier Flags

| Modifier | Flag Value |
|----------|-----------|
| Command (⌘) | 0x00100000 |
| Shift (⇧) | 0x00020000 |
| Control (⌃) | 0x00040000 |
| Option/Alt (⌥) | 0x00080000 |

## Electron App Considerations

Electron apps (Feishu, VS Code, Slack, Discord) have incomplete Accessibility API support:

| Method | Click | Type | Read UI State |
|--------|-------|------|---------------|
| **CGEvent** | ✅ Reliable | ✅ Via clipboard | ❌ Cannot read |
| **AX API** | ⚠️ Unreliable | ⚠️ Unreliable | ⚠️ Partial (if accessibility enabled) |

Recommendation: Use CGEvent for all interactions. For reading UI state, use screenshot analysis instead of AX.

## Permissions

### Required: Accessibility Permission
- **System Settings → Privacy & Security → Accessibility**
- The terminal/app running these scripts must be listed and enabled
- Changes require app restart to take effect

### Optional: Screen Recording
- Required only for `screencapture` of other apps' windows on macOS 10.15+
- **System Settings → Privacy & Security → Screen Recording**

### Error if Missing
If Accessibility permission is not granted:
- `CGEventCreateMouseEvent` returns null
- `CGEventCreateKeyboardEvent` returns null
- Scripts return: `{"success": false, "error": "CGEventCreateMouseEvent returned null — check Accessibility permission"}`

## Dependency Summary

| Tool | macOS Built-in | Purpose |
|------|---------------|---------|
| CoreGraphics.framework | ✅ | CGEvent mouse/keyboard events |
| AppKit.framework | ✅ | NSScreen scale factor |
| `screencapture` | ✅ | Screenshot capture |
| `sips` | ✅ | Image metadata (dimensions) |
| `osascript` | ✅ | AppleScript execution |
| `pbcopy`/`pbpaste` | ✅ | Clipboard for CJK input |
| `python3` | ✅ (since macOS 12.3) | Script runtime |

**No external dependencies required** (no brew install, no pip install, no cliclick).

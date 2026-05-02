---
name: mac-control
description: Mac screen control and desktop automation specialist - controls mouse, keyboard, and captures screenshots on macOS using CGEvent and native commands. Use when user wants to automate desktop interactions, control GUI applications, take and analyze screenshots, or perform UI testing on macOS.
allowed-tools: [Bash, Read, Write, mcp__4_5v_mcp__analyze_image]
---

# Mac Control Agent

You are a macOS desktop automation specialist. You control mouse, keyboard, and capture screenshots to interact with desktop applications.

> **Platform Requirement**: macOS only. All commands require Accessibility permissions (System Settings → Privacy & Security → Accessibility).

## Technical Rationale

This skill enables the Agent to:
1. **See the screen** — capture screenshots of the full screen, a region, or a specific window
2. **Interact with UI** — click, type, drag using hardware-level events (CGEvent)
3. **Handle Retina displays** — automatically convert between pixel and logical coordinates
4. **Work with any app** — Electron, native, Java — CGEvent works universally

## Core Concepts

### Coordinate System

macOS uses **logical points** for CGEvent coordinates. On Retina displays, screenshots are captured at **pixel resolution** (2x on standard Retina).

```
screenshot_pixel_coord / backingScaleFactor = CGEvent_logical_coord
```

**Example** (Retina with scale factor 2.0):
- Screenshot pixel: (400, 300)
- CGEvent click: (200, 150)

### Text Input Strategy

For Chinese/CJK text, use **clipboard paste** instead of keyboard event injection:
1. Save current clipboard
2. `echo -n "text" | pbcopy`
3. Send Cmd+V keystroke
4. Restore clipboard

This bypasses IME entirely and handles all Unicode characters.

## Workflow

### Basic Interaction Pattern

```
Screenshot → Analyze → Calculate logical coords → Click/Type → Verify
```

1. **Capture**: Take a screenshot of the target area
2. **Analyze**: Identify the target element and its pixel coordinates
3. **Convert**: Divide pixel coordinates by scale factor for logical coords
4. **Act**: Click, type, or drag at the logical coordinates
5. **Verify**: Take another screenshot to confirm the action succeeded

### Step-by-Step Guide

#### 1. Calibrate (First Run Only)

```bash
bash skills/mac-control/scripts/calibrate.sh
```

This detects:
- `backingScaleFactor` (1.0 for non-Retina, 2.0 for Retina)
- Screen dimensions in both pixels and logical points
- Available displays

Store the scale factor for subsequent operations.

#### 2. Take Screenshot

```bash
# Full screen
bash skills/mac-control/scripts/screenshot.sh /tmp/screen.png

# Specific region (x, y, width, height in LOGICAL points)
bash skills/mac-control/scripts/screenshot.sh /tmp/region.png -r 100 200 400 300

# Specific window (by app name)
bash skills/mac-control/scripts/screenshot.sh /tmp/window.png -w "Feishu"
```

#### 3. Analyze Screenshot

Use the image analysis tool to identify UI elements and their positions in the screenshot. Remember: positions in the screenshot image are in **pixel coordinates**.

#### 4. Click at Position

```bash
# Left click (x, y in LOGICAL points)
bash skills/mac-control/scripts/click.py click 200 150

# Right click
bash skills/mac-control/scripts/click.py right-click 200 150

# Double click
bash skills/mac-control/scripts/click.py double-click 200 150

# Drag from (200,150) to (400,300)
bash skills/mac-control/scripts/click.py drag 200 150 400 300
```

**Coordinate Conversion**: If the screenshot shows a button at pixel (400, 300) and the scale factor is 2.0:
```bash
# Convert: 400/2.0 = 200, 300/2.0 = 150
bash skills/mac-control/scripts/click.py click 200 150
```

#### 5. Type Text

```bash
# Type Chinese or any Unicode text
bash skills/mac-control/scripts/type-text.sh "你好世界"

# Type with a small delay between paste and continue
bash skills/mac-control/scripts/type-text.sh "Long text here..." --delay 0.5
```

#### 6. Get Window Information

```bash
# Get bounds of a specific app window
bash skills/mac-control/scripts/window-bounds.sh "Feishu"

# Returns JSON:
# {"x": 0, "y": 25, "width": 1440, "height": 875, "scaleFactor": 2.0}
```

#### 7. Find UI Elements (Accessibility API)

```bash
# Find buttons in an app
bash skills/mac-control/scripts/find-element.sh "Feishu" --role AXButton

# Find elements containing text
bash skills/mac-control/scripts/find-element.sh "Feishu" --text "Send"

# Find text fields
bash skills/mac-control/scripts/find-element.sh "Feishu" --role AXTextField
```

## Advanced Patterns

### Cross-App Workflow

```
1. Activate target app:  osascript -e 'tell application "Feishu" to activate'
2. Wait for window:      sleep 1
3. Get window bounds:    window-bounds.sh "Feishu"
4. Screenshot window:    screenshot.sh /tmp/feishu.png -w "Feishu"
5. Analyze and interact: click.py, type-text.sh
6. Verify result:        screenshot.sh /tmp/result.png
```

### Form Filling

```
1. Screenshot the form
2. Identify each field position
3. For each field:
   a. Click on the field
   b. Wait 0.3s (focus animation)
   c. Clear existing text: Cmd+A then Delete
   d. Type the value using type-text.sh
4. Submit the form
```

### Error Recovery

If an action doesn't produce the expected result:
1. Take a verification screenshot
2. Compare with expected state
3. If different, try:
   - Re-clicking (may have missed due to animation)
   - Adding a longer delay (app may be loading)
   - Using keyboard navigation instead (Tab + Enter)

## Important Constraints

1. **Permissions Required**: Terminal/iTerm must have Accessibility access
2. **No Headless Mode**: Requires a logged-in macOS session with GUI
3. **Single Display**: Multi-monitor setups need additional offset calculations
4. **Timing**: Always add delays between actions for animations to complete
5. **Clipboard**: Text input temporarily modifies the clipboard — warn users

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Click lands in wrong spot | Wrong coordinate system | Verify scale factor with `calibrate.sh` |
| Click doesn't register | Missing Accessibility permission | Grant in System Settings |
| Chinese text garbled | Using keyboard events instead of clipboard | Always use `type-text.sh` |
| Screenshot is blank | Screen recording permission | Grant in System Settings |
| Window not found | App minimized or hidden | Activate app first with osascript |

## Reference

- CGEvent coordinates are always in logical points (global display space)
- `backingScaleFactor` is typically 2.0 on Retina, 1.0 on non-Retina
- `pbcopy + Cmd+V` is the most reliable text input method for all languages
- CGEvent generates hardware-level events — all apps treat them as real input
- Accessibility API works for reading UI state even on Electron apps

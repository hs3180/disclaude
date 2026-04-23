---
name: mac-screen-control
description: Mac screen control and accessibility automation - controls mouse, keyboard, and screenshots via macOS Accessibility API and CGEvent. Use when user wants to automate desktop apps, click UI elements, type text (including CJK), take screenshots, or interact with macOS applications.
allowed-tools: Bash, Read
---

# Mac Screen Control Skill

macOS desktop automation via CGEvent and Accessibility API. Provides mouse control, keyboard input (including CJK), screenshot capture, and UI element interaction.

> **Platform**: macOS only. Requires Accessibility permission in System Settings → Privacy & Security → Accessibility.

## Quick Start

Before first use, verify prerequisites:

```bash
python3 scripts/mac-control.py check
```

## Core Operations

### 1. Screenshot

Capture screen for visual analysis:

```bash
# Full screenshot → returns path to PNG
python3 scripts/mac-control.py screenshot --output /tmp/screen.png

# Region screenshot (x,y,width,height in logical points)
python3 scripts/mac-control.py screenshot --output /tmp/region.png --region 100,200,400,300

# Specific display (multi-monitor)
python3 scripts/mac-control.py screenshot --output /tmp/display2.png --display 2
```

### 2. Mouse Control

All coordinates use **logical points** (not pixels). For Retina: `logical_point = pixel / backingScaleFactor`.

```bash
# Left click
python3 scripts/mac-control.py click 500 300

# Right click
python3 scripts/mac-control.py click 500 300 --button right

# Double click
python3 scripts/mac-control.py click 500 300 --double

# Move mouse (no click)
python3 scripts/mac-control.py move 500 300

# Drag from point A to point B
python3 scripts/mac-control.py drag 100 100 500 300
```

### 3. Keyboard Input

**For CJK/Unicode text**: Uses clipboard paste method (pbcopy + Cmd+V) — the most reliable approach for Chinese, Japanese, Korean, emoji, and composed characters.

```bash
# Type text (auto-detects: ASCII uses key events, non-ASCII uses clipboard)
python3 scripts/mac-control.py type "Hello World"
python3 scripts/mac-control.py type "你好世界"

# Type with a delay between keystrokes (ms)
python3 scripts/mac-control.py type "Hello" --delay 50

# Press keyboard shortcut
python3 scripts/mac-control.py key cmd --with c          # Copy
python3 scripts/mac-control.py key cmd --with v          # Paste
python3 scripts/mac-control.py key cmd --with shift --with 3  # Screenshot
python3 scripts/mac-control.py key enter
python3 scripts/mac-control.py key tab
python3 scripts/mac-control.py key escape
```

### 4. Window Management

```bash
# Get window info (position, size, title) for an app
python3 scripts/mac-control.py window "Feishu"

# Activate (bring to front) an app
python3 scripts/mac-control.py activate "Feishu"

# List all visible windows
python3 scripts/mac-control.py window --list

# Get current mouse position
python3 scripts/mac-control.py mousepos
```

### 5. UI Element Discovery (Accessibility API)

```bash
# Find elements by role in an app
python3 scripts/mac-control.py find-element "Feishu" --role AXButton

# Find elements by title
python3 scripts/mac-control.py find-element "Feishu" --title "Send"

# List the accessibility tree (first 3 levels)
python3 scripts/mac-control.py ax-tree "Feishu" --depth 3
```

### 6. Coordinate Calibration

```bash
# Get Retina scale factor and screen info
python3 scripts/mac-control.py calibrate
```

## Typical Workflows

### Workflow: Click a UI Element in Feishu

```
1. Activate app:     python3 scripts/mac-control.py activate "Feishu"
2. Screenshot:       python3 scripts/mac-control.py screenshot --output /tmp/feishu.png
3. (Analyze image to find target coordinates)
4. Click:            python3 scripts/mac-control.py click X Y
5. Verify:           python3 scripts/mac-control.py screenshot --output /tmp/result.png
```

### Workflow: Type Chinese into a Text Field

```
1. Click text field:  python3 scripts/mac-control.py click X Y
2. Small delay:       sleep 0.3
3. Type Chinese:      python3 scripts/mac-control.py type "你好世界"
4. Press Enter:       python3 scripts/mac-control.py key enter
```

### Workflow: Multi-step App Interaction

```
1. Activate:    python3 scripts/mac-control.py activate "Google Chrome"
2. Screenshot:  python3 scripts/mac-control.py screenshot --output /tmp/step1.png
3. Click:       python3 scripts/mac-control.py click X Y
4. Wait:        sleep 1.0
5. Type:        python3 scripts/mac-control.py type "search query"
6. Key press:   python3 scripts/mac-control.py key enter
```

## Important Notes

### Coordinate System
- All coordinates are in **logical points** (CGEvent coordinate space)
- For Retina displays: `logical_point = pixel_coordinate / backingScaleFactor`
- The screenshot tool returns pixel coordinates; divide by scale factor for click targets

### Text Input
- ASCII text (a-z, 0-9, basic punctuation) uses CGEvent key events
- Non-ASCII text (CJK, emoji, accented chars) uses **clipboard paste** (pbcopy + Cmd+V)
- Clipboard contents are saved and restored after paste (non-destructive)

### Permissions
- Requires **Accessibility** permission: System Settings → Privacy & Security → Accessibility
- Add Terminal.app or the running app to the allowed list
- Some operations require **Screen Recording** permission for screenshots

### Limitations
- Remote/headless servers without a display cannot use this skill
- Electron apps may have limited Accessibility API support — use visual methods as fallback
- Multi-monitor setups need display parameter for correct screenshot targeting

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Click position is off | Run `calibrate` to check scale factor; ensure using logical points not pixels |
| Chinese input fails | Verify clipboard paste works manually: `echo -n "测试" \| pbcopy` then Cmd+V |
| Permission denied | Check Accessibility permission in System Settings |
| App not found | Use `window --list` to see available app names |
| Screenshot is black | Check Screen Recording permission |

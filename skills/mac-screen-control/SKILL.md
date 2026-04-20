---
name: mac-screen-control
description: Mac screen/keyboard/mouse control via macOS Accessibility API and CGEvent. Use when user wants to automate desktop apps, click UI elements, type text (including Chinese), take screenshots, or control windows on macOS.
allowed-tools: Read, Write, Bash
user-invocable: true
---

# Mac Screen Control Agent

You are a professional macOS desktop automation agent. You control the screen, keyboard, and mouse using native macOS tools.

> **Platform Requirement**: This skill only works on macOS with Accessibility permissions granted (System Settings > Privacy & Security > Accessibility).

## Technical Rationale

This skill enables AI agents to:
1. **Control desktop apps** — Click, type, and interact with any macOS application
2. **Handle CJK input** — Uses clipboard-based paste method to bypass IME interception
3. **Visual automation** — Screenshot + analyze + act workflow
4. **Retina-aware** — Automatic coordinate calibration for Retina displays

## CLI Script

The core script is `skills/mac-screen-control/mac-control.ts`. It provides the following actions:

```bash
# Take a screenshot
npx tsx skills/mac-screen-control/mac-control.ts --action screenshot [--output /tmp/screen.png] [--region x,y,w,h]

# Click at coordinates
npx tsx skills/mac-screen-control/mac-control.ts --action click --x 100 --y 200 [--button left|right|double]

# Type text (supports Chinese via clipboard paste)
npx tsx skills/mac-screen-control/mac-control.ts --action type --text "Hello 你好"

# Press a key with optional modifiers
npx tsx skills/mac-screen-control/mac-control.ts --action key --key return [--modifiers cmd,shift]

# Get window bounds for an application
npx tsx skills/mac-screen-control/mac-control.ts --action get-window --app "Google Chrome"

# Activate (bring to front) an application
npx tsx skills/mac-screen-control/mac-control.ts --action activate-app --app "Feishu"

# Calibrate Retina scaling factor
npx tsx skills/mac-screen-control/mac-control.ts --action calibrate

# Move mouse to coordinates
npx tsx skills/mac-screen-control/mac-control.ts --action move --x 100 --y 200

# Drag from one point to another
npx tsx skills/mac-screen-control/mac-control.ts --action drag --from-x 100 --from-y 100 --to-x 300 --to-y 300

# Find UI elements via Accessibility API
npx tsx skills/mac-screen-control/mac-control.ts --action find-element --app "Safari" [--role AXButton] [--title "Save"]
```

## Output Format

All actions return JSON to stdout:

```json
{
  "success": true,
  "action": "screenshot",
  "data": { "path": "/tmp/screen.png", "width": 2880, "height": 1800 }
}
```

On error:

```json
{
  "success": false,
  "action": "click",
  "error": "Failed to click: accessibility permission denied"
}
```

## Common Workflows

### Workflow 1: Screenshot → Analyze → Click

1. Take screenshot: `--action screenshot --output /tmp/screen.png`
2. Use `Read` tool to view the screenshot and identify target coordinates
3. Click: `--action click --x {x} --y {y}`

### Workflow 2: Find Element → Interact

1. Find element: `--action find-element --app "Feishu" --title "Send"`
2. Parse JSON to get element position
3. Click: `--action click --x {x} --y {y}`

### Workflow 3: Type Chinese Text

1. Click on input field: `--action click --x {x} --y {y}`
2. Type text: `--action type --text "你好世界"`
3. The script automatically uses clipboard paste (pbcopy + Cmd+V) for non-ASCII text

### Workflow 4: App Navigation

1. Activate app: `--action activate-app --app "Feishu"`
2. Get window bounds: `--action get-window --app "Feishu"`
3. Use bounds to calculate click positions
4. Interact with elements

## Coordinate System

- Coordinates are in **logical points** (not pixels)
- On Retina displays, screenshot pixel coordinates must be divided by `backingScaleFactor` (typically 2.0)
- Use `--action calibrate` to detect the current scale factor
- Window bounds from `get-window` are already in logical points

## Important Notes

1. **Accessibility Permission**: First-time use requires granting Accessibility permission in System Settings
2. **Retina Displays**: Always calibrate before first use on Retina Macs
3. **Text Input**: Non-ASCII text (Chinese, Japanese, Korean, emoji) is automatically handled via clipboard paste
4. **Timing**: Some apps need brief delays between actions; the script adds small pauses automatically
5. **Error Recovery**: If an action fails, check the error message and retry with adjusted parameters

## DO NOT

- Do NOT attempt to control login/keychain dialogs (security restriction)
- Do NOT interact with System Settings without explicit user consent
- Do NOT send rapid-fire inputs that could overwhelm applications
- Do NOT use this skill on non-macOS systems

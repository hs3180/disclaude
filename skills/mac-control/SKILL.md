---
name: mac-control
description: Mac screen control and accessibility automation - control mouse, keyboard, take screenshots, and interact with UI elements on macOS desktop applications. Use when user wants to automate desktop interactions, control Feishu app, or perform screen-based operations on macOS. Keywords: "mac控制", "屏幕控制", "桌面自动化", "mac automation", "screen control", "desktop automation".
allowed-tools: Bash, Read
---

# Mac Control — macOS Accessibility Automation

Control macOS desktop applications through screen capture, mouse/keyboard events, and Accessibility API.

> **Platform**: macOS only. Requires Accessibility permission in System Settings > Privacy & Security.

## Technical Rationale

This skill wraps macOS-native tools (`osascript`, `screencapture`, `cliclick`) into a programmatic TypeScript interface that Claude can invoke. It enables desktop automation workflows like:
- Opening and interacting with Feishu desktop app
- Automating repetitive UI interactions
- Visual verification via screenshots

## Core Operations

The helper script `mac-control.ts` provides these operations via environment variables:

### 1. Screenshot

```bash
MAC_OP=screenshot \
MAC_OUTPUT=/tmp/screenshot.png \
npx tsx skills/mac-control/mac-control.ts
```

Options:
- `MAC_REGION` — Crop region as `x,y,width,height` (optional, full screen if omitted)
- `MAC_SHOW_CURSOR` — Set to `true` to include cursor in screenshot (default: false)

### 2. Mouse Click

```bash
MAC_OP=click \
MAC_X=500 \
MAC_Y=300 \
npx tsx skills/mac-control/mac-control.ts
```

Options:
- `MAC_BUTTON` — `left` (default), `right`, or `center`
- `MAC_CLICKS` — Number of clicks: `1` (default) or `2` (double-click)

### 3. Type Text

```bash
MAC_OP=type \
MAC_TEXT="Hello 你好" \
npx tsx skills/mac-control/mac-control.ts
```

Uses clipboard-based input (`pbcopy` + `Cmd+V`) to support CJK and emoji characters.

Options:
- `MAC_TYPE_MODE` — `clipboard` (default, recommended for CJK) or `keystroke` (ASCII only)

### 4. Key Press

```bash
MAC_OP=key \
MAC_KEY=return \
npx tsx skills/mac-control/mac-control.ts
```

Supports modifier combinations:
- `MAC_MODIFIERS` — Comma-separated: `command,shift,control,option`

Examples:
```bash
# Cmd+S (Save)
MAC_OP=key MAC_KEY=s MAC_MODIFIERS=command npx tsx skills/mac-control/mac-control.ts

# Cmd+Shift+4 (Screenshot region)
MAC_OP=key MAC_KEY=4 MAC_MODIFIERS=command,shift npx tsx skills/mac-control/mac-control.ts
```

### 5. Get Window Bounds

```bash
MAC_OP=get-window \
MAC_APP="Feishu" \
npx tsx skills/mac-control/mac-control.ts
```

Returns JSON with `x, y, width, height` of the app's frontmost window.

### 6. Activate Application

```bash
MAC_OP=activate-app \
MAC_APP="Feishu" \
npx tsx skills/mac-control/mac-control.ts
```

Brings the application to the foreground.

### 7. Calibrate Display

```bash
MAC_OP=calibrate \
npx tsx skills/mac-control/mac-control.ts
```

Returns the Retina scale factor and display information.

### 8. Mouse Move / Drag

```bash
# Move to position
MAC_OP=move MAC_X=500 MAC_Y=300 npx tsx skills/mac-control/mac-control.ts

# Drag from A to B
MAC_OP=drag MAC_X=100 MAC_Y=100 MAC_X2=500 MAC_Y2=300 npx tsx skills/mac-control/mac-control.ts
```

## Coordinate System

**Critical**: macOS Retina displays have two coordinate spaces:
- **Logical points** — Used by CGEvent and osascript (what you pass to this skill)
- **Physical pixels** — Used by screenshots (2x on Retina)

The `calibrate` operation returns the scale factor. To convert screenshot pixel coordinates to logical points:
```
logical_x = pixel_x / scale_factor
logical_y = pixel_y / scale_factor
```

## Workflow Pattern

A typical desktop automation workflow:

```
1. activate-app  → Bring target app to front
2. screenshot    → Capture current state
3. Analyze image → Identify target element coordinates
4. click         → Click the element
5. type          → Enter text (if needed)
6. screenshot    → Verify the result
```

## Clipboard Preservation

The `type` operation with `clipboard` mode saves and restores the clipboard contents to avoid disrupting the user's workflow.

## Error Handling

- All operations return structured JSON on stdout
- `{"success": true, ...}` on success
- `{"success": false, "error": "..."}` on failure
- Exit code 0 on success, 1 on failure

## Prerequisites

### Required (auto-detected)
- **macOS** — This skill only works on macOS
- **cliclick** — Install via `brew install cliclick` (for mouse/keyboard control)
- **osascript** — Built into macOS (for window management and Accessibility)

### Optional
- **Accessibility Permission** — Required for some operations. Grant in System Settings > Privacy & Security > Accessibility

## Safety Considerations

- CGEvent generates hardware-level events that applications cannot distinguish from real user input
- Use small delays between operations to allow UI to update
- Always verify state with screenshots after critical operations
- Avoid automating sensitive operations (passwords, financial transactions) without explicit user confirmation

## DO NOT

- Do NOT use this skill on non-macOS platforms (will fail gracefully)
- Do NOT attempt to bypass authentication or security dialogs
- Do NOT perform rapid-fire operations without delays (may trigger anti-automation measures)
- Do NOT interact with System Settings > Privacy panels programmatically (requires manual user action)

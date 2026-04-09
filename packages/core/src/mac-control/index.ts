/**
 * macOS Screen Control Module.
 *
 * Provides foundational utilities for AI agents to interact with macOS desktop
 * applications via screen capture, mouse control, window management, and
 * coordinate calibration.
 *
 * **Platform**: macOS only. All functions throw `MacControlError` on non-macOS platforms.
 *
 * **Permissions required**:
 * - Screen Recording: For `captureScreen()` → System Settings → Privacy & Security → Screen Recording
 * - Accessibility: For mouse/window operations → System Settings → Privacy & Security → Accessibility
 *
 * **Dependencies**:
 * - `screencapture`: Built-in macOS command (always available)
 * - `cliclick`: Third-party tool, install with `brew install cliclick`
 * - `osascript`: Built-in macOS command (always available)
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 基础工具封装
 *
 * @example
 * ```typescript
 * import { captureScreen, calibrate, click, getAppWindow } from '@disclaude/core/mac-control';
 *
 * // 1. Calibrate coordinate system
 * const screenshot = await captureScreen();
 * const calibration = await calibrate(screenshot);
 *
 * // 2. Get window position
 * const window = await getAppWindow('Feishu');
 *
 * // 3. Click at a position relative to the window
 * await click(window.bounds.x + 100, window.bounds.y + 50);
 * ```
 */

// Types
export type {
  Point,
  Rect,
  ScreenshotOptions,
  ScreenshotResult,
  ClickOptions,
  WindowInfo,
  CalibrationResult,
} from './types.js';

// Constants
export { CLICK_BUTTON_MAP, MODIFIER_MAP } from './types.js';

// Screen Capture
export { captureScreen, MacControlError, parsePngDimensions, execWithTimeout } from './screen-capture.js';

// Mouse Control
export {
  click,
  move,
  drag,
  doubleClick,
  rightClick,
  isCliclickAvailable,
} from './mouse-control.js';

// Window Info
export {
  getAppWindow,
  activateApp,
  listAppWindows,
  getScreenResolution,
} from './window-info.js';

// Calibration
export {
  calibrate,
  getCachedCalibration,
  clearCalibrationCache,
  pixelToLogical,
  logicalToPixel,
  pixelToWindowRelative,
  fullCalibration,
} from './calibration.js';

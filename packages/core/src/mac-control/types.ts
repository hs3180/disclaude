/**
 * Type definitions for the macOS screen control module.
 *
 * Provides interfaces for screen capture, mouse control, window management,
 * and coordinate calibration — enabling AI agents to interact with desktop
 * applications via macOS Accessibility APIs and system utilities.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 基础工具封装
 */

/** A point in screen coordinate space (logical/Cocoa coordinates). */
export interface Point {
  /** Horizontal position in logical (Cocoa) pixels. */
  x: number;
  /** Vertical position in logical (Cocoa) pixels. */
  y: number;
}

/** A rectangular region defined by two corners. */
export interface Rect {
  /** X coordinate of the top-left corner. */
  x: number;
  /** Y coordinate of the top-left corner. */
  y: number;
  /** Width in logical pixels. */
  width: number;
  /** Height in logical pixels. */
  height: number;
}

/** Options for screen capture operations. */
export interface ScreenshotOptions {
  /**
   * Optional region to capture. If omitted, captures the entire screen.
   * Coordinates are in logical (Cocoa) pixel space.
   */
  region?: Rect;
  /** Whether to include the cursor in the screenshot. Default: false. */
  cursor?: boolean;
  /**
   * Output file path. If omitted, a temp file is created.
   * The file will be in PNG format.
   */
  outputPath?: string;
}

/** Result of a screen capture operation. */
export interface ScreenshotResult {
  /** Path to the captured PNG file. */
  filePath: string;
  /** Width of the captured image in pixels. */
  width: number;
  /** Height of the captured image in pixels. */
  height: number;
  /** Raw image data as a Buffer. */
  buffer: Buffer;
}

/** Options for mouse click operations. */
export interface ClickOptions {
  /** Mouse button to use. Default: 'left'. */
  button?: 'left' | 'right' | 'middle';
  /** Number of clicks. 1 = single, 2 = double. Default: 1. */
  clicks?: number;
  /** Key modifiers to hold during click (e.g., 'cmd', 'shift', 'alt'). */
  modifiers?: string[];
}

/** Information about an application window. */
export interface WindowInfo {
  /** Application process name (e.g., 'Feishu', 'Google Chrome'). */
  appName: string;
  /** Window title/label. */
  title: string;
  /** Window bounds in logical (Cocoa) coordinates. */
  bounds: Rect;
  /** Whether the window is currently in the foreground. */
  isFrontmost: boolean;
  /** Window index among the app's windows (1-based). */
  windowIndex: number;
}

/** Result of coordinate calibration. */
export interface CalibrationResult {
  /**
   * Scale factor from screenshot pixels to logical (cliclick) coordinates.
   * On a standard display this is 1.0; on Retina it's typically 2.0.
   */
  scaleFactor: number;
  /** Main display resolution in logical pixels. */
  screenResolution: Rect;
  /** Timestamp of when calibration was performed. */
  calibratedAt: number;
}

/**
 * Supported mouse button identifiers for cliclick.
 * @internal
 */
export const CLICK_BUTTON_MAP: Record<string, string> = {
  left: '',
  right: 'rc',
  middle: 'mc',
};

/**
 * Key modifier mapping from user-friendly names to cliclick syntax.
 * cliclick uses: cmd=⌘, alt=⌥, shift=⇧, ctrl=⌃
 * @internal
 */
export const MODIFIER_MAP: Record<string, string> = {
  cmd: 'cmd',
  shift: 'shift',
  alt: 'alt',
  ctrl: 'ctrl',
};

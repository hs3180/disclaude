/**
 * Coordinate calibration utility for macOS.
 *
 * On Retina displays, there's a discrepancy between:
 * - **Screenshot pixels**: Physical resolution (e.g., 5120×3200 on a 16" MacBook Pro)
 * - **Logical coordinates**: Cocoa/cliclick coordinate space (e.g., 2560×1600)
 *
 * This module provides automatic calibration by comparing screenshot dimensions
 * with the known logical screen resolution to determine the scale factor.
 *
 * Issue #2216: Mac 屏幕控制能力 - 辅助功能自动化模块
 * Phase 1: 坐标校准机制
 */

import type { CalibrationResult, Rect, ScreenshotResult } from './types.js';
import { getScreenResolution } from './window-info.js';
import { MacControlError } from './screen-capture.js';

/**
 * Cached calibration result to avoid redundant calibration.
 * @internal
 */
let cachedCalibration: CalibrationResult | null = null;

/**
 * Calibrate screen coordinates by comparing screenshot resolution
 * with the logical screen resolution.
 *
 * This determines the scale factor (typically 1.0 for standard displays
 * and 2.0 for Retina displays). The result is cached for subsequent calls.
 *
 * @param screenshot - A full-screen screenshot result
 * @returns CalibrationResult with scale factor and screen info
 * @throws {MacControlError} If calibration fails
 *
 * @example
 * ```typescript
 * const screenshot = await captureScreen();
 * const calibration = await calibrate(screenshot);
 * console.log(`Scale factor: ${calibration.scaleFactor}`); // 2.0 on Retina
 *
 * // Convert screenshot pixel to logical coordinate:
 * const logicalX = screenshotPixelX / calibration.scaleFactor;
 * ```
 */
export async function calibrate(screenshot: ScreenshotResult): Promise<CalibrationResult> {
  // Get logical screen resolution
  const screenResolution = await getScreenResolution();

  // Calculate scale factor from screenshot dimensions vs logical resolution
  // Use the dimension with the larger difference to reduce rounding errors
  const widthRatio = screenshot.width / screenResolution.width;
  const heightRatio = screenshot.height / screenResolution.height;

  // Both ratios should be approximately equal; pick the one closest to an integer
  const scaleFactor = Math.abs(widthRatio - Math.round(widthRatio))
    < Math.abs(heightRatio - Math.round(heightRatio))
    ? Math.round(widthRatio)
    : Math.round(heightRatio);

  if (scaleFactor < 1) {
    throw new MacControlError(
      `Invalid scale factor calculated: ${scaleFactor}. ` +
      `Screenshot dimensions (${screenshot.width}x${screenshot.height}) ` +
      `are smaller than screen resolution (${screenResolution.width}x${screenResolution.height}). ` +
      `Ensure a full-screen capture was used for calibration.`,
    );
  }

  const result: CalibrationResult = {
    scaleFactor,
    screenResolution,
    calibratedAt: Date.now(),
  };

  // Cache the result
  cachedCalibration = result;

  return result;
}

/**
 * Get the cached calibration result, or null if not yet calibrated.
 *
 * @returns Cached CalibrationResult or null
 */
export function getCachedCalibration(): CalibrationResult | null {
  return cachedCalibration;
}

/**
 * Clear the cached calibration result.
 * Call this when the display configuration changes (e.g., connecting external monitor).
 */
export function clearCalibrationCache(): void {
  cachedCalibration = null;
}

/**
 * Convert screenshot pixel coordinates to logical (cliclick) coordinates.
 *
 * @param pixelX - X position in screenshot pixels
 * @param pixelY - Y position in screenshot pixels
 * @param calibration - Calibration result with scale factor
 * @returns Logical coordinates for use with cliclick
 */
export function pixelToLogical(
  pixelX: number,
  pixelY: number,
  calibration: CalibrationResult,
): { x: number; y: number } {
  return {
    x: Math.round(pixelX / calibration.scaleFactor),
    y: Math.round(pixelY / calibration.scaleFactor),
  };
}

/**
 * Convert logical (cliclick) coordinates to screenshot pixel coordinates.
 *
 * @param logicalX - X position in logical pixels
 * @param logicalY - Y position in logical pixels
 * @param calibration - Calibration result with scale factor
 * @returns Screenshot pixel coordinates
 */
export function logicalToPixel(
  logicalX: number,
  logicalY: number,
  calibration: CalibrationResult,
): { x: number; y: number } {
  return {
    x: Math.round(logicalX * calibration.scaleFactor),
    y: Math.round(logicalY * calibration.scaleFactor),
  };
}

/**
 * Convert screenshot pixel coordinates to coordinates relative to a window.
 *
 * Useful when you've identified a UI element in a screenshot and need to
 * click it relative to the window's position on screen.
 *
 * @param pixelX - X position in screenshot pixels
 * @param pixelY - Y position in screenshot pixels
 * @param windowBounds - Window bounds in logical coordinates
 * @param calibration - Calibration result with scale factor
 * @returns Logical coordinates relative to the window
 */
export function pixelToWindowRelative(
  pixelX: number,
  pixelY: number,
  windowBounds: Rect,
  calibration: CalibrationResult,
): { x: number; y: number } {
  const logical = pixelToLogical(pixelX, pixelY, calibration);
  return {
    x: logical.x - windowBounds.x,
    y: logical.y - windowBounds.y,
  };
}

/**
 * Perform a full calibration flow: capture screenshot + calculate scale factor.
 *
 * This is a convenience function that combines capture and calibration
 * in a single call. The result is cached for subsequent operations.
 *
 * @returns CalibrationResult
 * @throws {MacControlError} If capture or calibration fails
 */
export async function fullCalibration(): Promise<CalibrationResult> {
  // Dynamic import to avoid circular dependency
  const { captureScreen } = await import('./screen-capture.js');
  const screenshot = await captureScreen();
  return calibrate(screenshot);
}

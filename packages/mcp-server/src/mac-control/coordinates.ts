/**
 * Retina display coordinate conversion utilities.
 *
 * macOS uses **logical points** for CGEvent coordinates but screenshots
 * capture in **pixel** space. On Retina displays, the backing scale factor
 * is typically 2× (NSScreen.main?.backingScaleFactor).
 *
 * Key rule: CGEvent coordinates are always in logical points.
 * Screenshot pixel coordinates must be divided by backingScaleFactor
 * before passing to click/type APIs.
 *
 * Issue #2216: Resolves coordinate mismatch problem.
 *
 * @module mac-control/coordinates
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Cached backing scale factor (avoid querying system on every call). */
let cachedScaleFactor: number | null = null;

/**
 * Get the Retina backing scale factor.
 *
 * Queries the system via `system_profiler` or falls back to parsing
 * `system_profiler SPDisplaysDataType`. Returns 1 for non-Retina, 2 for Retina.
 *
 * This is the ratio: pixel_coordinate / logical_point = backingScaleFactor.
 */
export async function getBackingScaleFactor(): Promise<number> {
  if (cachedScaleFactor !== null) {
    return cachedScaleFactor;
  }

  try {
    // Use osascript to get NSScreen.main backingScaleFactor
    const { stdout } = await execFileAsync('osascript', [
      '-e', 'return NSScreen\'s mainScreen\'s backingScaleFactor()',
    ], { timeout: 5000 });

    const factor = parseFloat(stdout.trim());
    if (Number.isFinite(factor) && factor > 0) {
      cachedScaleFactor = factor;
      return factor;
    }
  } catch {
    // osascript bridge may not be available in all environments
  }

  try {
    // Fallback: check system_profiler for Retina
    const { stdout } = await execFileAsync('system_profiler', [
      'SPDisplaysDataType', '-detailLevel', 'mini',
    ], { timeout: 10000 });

    // Retina displays report "Retina" in the output
    if (stdout.includes('Retina')) {
      cachedScaleFactor = 2;
      return 2;
    }
  } catch {
    // system_profiler may not be available
  }

  // Default: non-Retina display
  cachedScaleFactor = 1;
  return 1;
}

/**
 * Convert pixel coordinates (from screenshot analysis) to logical points
 * (for CGEvent / osascript input).
 *
 * @param pixelX - X coordinate in pixel space (from screenshot)
 * @param pixelY - Y coordinate in pixel space (from screenshot)
 * @returns Coordinates in logical point space (for click/type)
 *
 * @example
 * ```ts
 * // Screenshot shows a button at pixel (1000, 600) on Retina
 * const [lx, ly] = await pixelToLogical(1000, 600);
 * // lx = 500, ly = 300 on 2× Retina
 * await mac.click(lx, ly);
 * ```
 */
export async function pixelToLogical(pixelX: number, pixelY: number): Promise<[number, number]> {
  const factor = await getBackingScaleFactor();
  return [Math.round(pixelX / factor), Math.round(pixelY / factor)];
}

/**
 * Convert logical points to pixel coordinates.
 *
 * @param logicalX - X coordinate in logical point space
 * @param logicalY - Y coordinate in logical point space
 * @returns Coordinates in pixel space
 */
export async function logicalToPixel(logicalX: number, logicalY: number): Promise<[number, number]> {
  const factor = await getBackingScaleFactor();
  return [Math.round(logicalX * factor), Math.round(logicalY * factor)];
}

/**
 * Clear the cached scale factor (useful for display changes).
 */
export function clearScaleCache(): void {
  cachedScaleFactor = null;
}

/**
 * Set the scale factor explicitly (useful for testing or known displays).
 */
export function setScaleFactor(factor: number): void {
  cachedScaleFactor = factor;
}

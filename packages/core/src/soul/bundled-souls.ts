/**
 * Bundled SOUL profiles - Pre-defined personality definitions for common scenarios.
 *
 * Issue #1228: Provides built-in SOUL profiles that can be loaded by name
 * without requiring users to create their own files.
 *
 * Usage:
 * ```typescript
 * import { getBundledSoulPath, DISCUSSION_SOUL_NAME } from '@disclaude/core';
 *
 * const soulPath = getBundledSoulPath(DISCUSSION_SOUL_NAME);
 * const loader = new SoulLoader(soulPath);
 * const result = await loader.load();
 * ```
 *
 * @module @disclaude/core/soul/bundled-souls
 */

import path from 'path';
import { fileURLToPath } from 'url';

/** Name identifier for the discussion SOUL profile. */
export const DISCUSSION_SOUL_NAME = 'discussion' as const;

/** All available bundled SOUL profile names. */
export type BundledSoulName = typeof DISCUSSION_SOUL_NAME;

/**
 * Directory containing bundled SOUL profile files.
 * Resolved relative to this source file.
 */
const SOULS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'souls',
);

/**
 * Get the absolute file path for a bundled SOUL profile.
 *
 * @param name - The bundled soul name (e.g., 'discussion')
 * @returns Absolute path to the SOUL.md file
 * @throws Error if the soul name is unknown
 *
 * @example
 * ```typescript
 * const soulPath = getBundledSoulPath('discussion');
 * // Returns: /path/to/packages/core/src/soul/souls/discussion.md
 * ```
 */
export function getBundledSoulPath(name: BundledSoulName): string {
  return path.join(SOULS_DIR, `${name}.md`);
}

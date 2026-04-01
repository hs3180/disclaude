/**
 * SOUL.md module - Agent personality/behavior definition system.
 *
 * Issue #1315: Provides infrastructure for injecting personality definitions
 * into Agent system prompts via SOUL.md files.
 *
 * @module @disclaude/core/soul
 */

export { SoulLoader, SOUL_MAX_SIZE_BYTES } from './loader.js';
export type { SoulLoadResult } from './loader.js';

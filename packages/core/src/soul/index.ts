/**
 * SOUL.md system module.
 *
 * Provides SoulLoader for reading SOUL.md personality definition files.
 * Used by Agent system to inject personality/behavior profiles into system prompts.
 *
 * @see Issue #1315 (SOUL.md infrastructure)
 * @see Issue #1228 (Discussion SOUL profile)
 *
 * @module @disclaude/core/soul
 */

export { SoulLoader, type SoulLoadResult } from './loader.js';

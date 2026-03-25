/**
 * SOUL.md module - Agent personality/behavior definition system.
 *
 * Issue #1315: Provides infrastructure for injecting personality definitions
 * into Agent system prompts via the systemPrompt.append mechanism.
 *
 * @module @disclaude/core/soul
 */

export {
  SoulLoader,
  MAX_SOUL_SIZE,
} from './loader.js';

export type {
  SoulLoadResult,
} from './loader.js';

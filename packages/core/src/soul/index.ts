/**
 * SOUL.md module - Agent personality/behavior definition system.
 *
 * Issue #1315: Provides infrastructure for injecting personality definitions
 * into Agent system prompts via the systemPrompt.append mechanism.
 * Issue #1228: Bundled discussion SOUL profile for focus-keeping in discussions.
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

export {
  getBundledSoulPath,
  DISCUSSION_SOUL_NAME,
} from './bundled-souls.js';

/**
 * Soul module - SOUL.md personality loading and injection.
 *
 * @module soul
 * @see Issue #1228 - Discussion focus keeping via SOUL.md
 * @see Issue #1315 - SOUL.md personality definition system
 */

export {
  loadSoul,
  loadSoulFile,
  expandTilde,
  formatSoulAsSystemPrompt,
  MAX_SOUL_SIZE_BYTES,
  type SoulLoadResult,
  type SoulLoadOptions,
} from './loader.js';

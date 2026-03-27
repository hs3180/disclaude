/**
 * Soul module - Agent personality/behavior definition system.
 *
 * Issue #1315: SOUL.md provides a mechanism for defining Agent personality
 * and behavioral guidelines through Markdown files, injected into the
 * system prompt at agent creation time.
 *
 * @module soul
 */

export {
  SoulLoader,
  SOUL_MAX_SIZE_BYTES,
  type SoulLoadResult,
  type SoulLoadError,
  type SoulLoadErrorReason,
} from './loader.js';

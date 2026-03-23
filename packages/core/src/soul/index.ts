/**
 * SOUL.md module - Agent personality/behavior definition system.
 *
 * Provides a simple mechanism for injecting personality definitions
 * into Agent system prompts via SOUL.md files.
 *
 * @module soul
 */

export {
  SoulLoader,
  createSoulLoader,
  getDefaultSoulPath,
  resolveSoulPath,
  expandTilde,
  type SoulLoadResult,
} from './loader.js';

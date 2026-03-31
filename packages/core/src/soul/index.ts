/**
 * SOUL.md personality module.
 *
 * Provides utilities for loading and managing SOUL.md personality files
 * that define AI agent behavior and personality.
 *
 * Issue #1315: SOUL.md - Agent personality/behavior definition system.
 */

export {
  loadSoulFile,
  resolveSoulPath,
  SOUL_MAX_SIZE_BYTES,
} from './loader.js';

export type {
  SoulLoadResult,
} from './loader.js';

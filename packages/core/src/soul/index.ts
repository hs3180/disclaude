/**
 * SOUL Module - Agent personality/behavior definition system.
 *
 * This module provides SOUL.md discovery and loading for Issue #1315:
 * - Find SOUL.md files across multiple search paths
 * - Load and merge SOUL.md content with priority
 * - Format for system prompt injection
 *
 * @module soul
 */

export {
  type DiscoveredSoul,
  type SoulLevel,
  type FindSoulOptions,
  type SoulContent,
  type SoulLifecycle,
  getSoulSearchPaths,
  findSoul,
  loadSoul,
  mergeSouls,
  loadMergedSoul,
  formatSoulForSystemPrompt,
} from './loader.js';

/**
 * SOUL.md - Agent personality/behavior definition system.
 *
 * Issue #1315: Enables users to define Agent personality via SOUL.md files.
 * The content is loaded and injected into the Agent's system prompt.
 *
 * @module soul
 */

export type { SoulConfig, SoulLoadResult } from './types.js';
export { SoulLoadError } from './types.js';
export { loadSoul, hasSoulConfig } from './soul-loader.js';

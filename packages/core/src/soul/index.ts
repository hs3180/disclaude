/**
 * SOUL module - Agent personality definition system.
 *
 * Provides utilities for loading SOUL.md personality files
 * and injecting them into agent system prompts.
 *
 * @module soul
 * @see Issue #1315
 */

export { loadSoulFile, resolveTilde, type SoulLoadResult } from './loader.js';

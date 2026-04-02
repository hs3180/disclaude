/**
 * SOUL.md module - Agent personality/behavior definition system.
 *
 * Issue #1315: SOUL.md provides a unified entry point for Agent behavior control.
 * Instead of hardcoding behavior rules, Agents read personality definitions from
 * Markdown files and inject them into the system prompt.
 *
 * Architecture:
 * ```
 * Startup → SoulLoader.load() → systemPromptAppend parameter → AgentFactory → createSdkOptions()
 * ```
 *
 * @module @disclaude/core/soul
 */

export { SoulLoader, SOUL_MAX_SIZE_BYTES, type SoulLoadResult } from './loader.js';

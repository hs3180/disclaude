/**
 * SOUL.md Module - Agent personality/behavior definition system.
 *
 * Issue #1315: SOUL.md - Agent 人格/行为定义系统
 *
 * This module provides a simple, single-path SOUL.md loader that reads
 * personality definitions from a Markdown file and injects them into
 * the Agent's system prompt.
 *
 * Architecture:
 * ```
 * Config (soul.path)
 *     └── SoulLoader(path)
 *             └── load() → content
 *                     └── system_prompt.append (via BaseAgent)
 * ```
 *
 * @module soul
 */

export {
  SoulLoader,
  type SoulLoadResult,
} from './loader.js';

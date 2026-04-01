/**
 * Soul module - Agent personality/behavior definition system.
 *
 * Issue #1315: SOUL.md infrastructure for Agent behavior control.
 *
 * This module provides the SoulLoader utility for loading SOUL.md personality
 * definition files. The loaded content is passed as `systemPromptAppend` to
 * the Agent SDK, allowing Agents to define their behavior through "self-awareness".
 *
 * @module soul
 */

export { SoulLoader, type SoulLoadResult } from './loader.js';

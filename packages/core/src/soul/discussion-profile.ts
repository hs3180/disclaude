/**
 * Discussion SOUL Profile - Defines the personality for focused discussion agents.
 *
 * Issue #1228: 讨论焦点保持 - 基于 SOUL.md 系统的讨论人格定义
 *
 * This module provides:
 * - A default discussion SOUL profile template with topic anchoring
 * - Functions to build discussion soul content with context (initial question)
 * - Constants for default file paths
 * - A detector function to identify discussion soul content
 *
 * Architecture:
 * ```
 * buildDiscussionSoulContent(question)
 *   → DISCUSSION_SOUL_TEMPLATE with {{initialQuestion}} replaced
 *   → Can be written to DEFAULT_DISCUSSION_SOUL_PATH
 *   → Loaded by SoulLoader (Issue #1315) when needed
 *   → Or passed directly to agent's system prompt
 * ```
 *
 * Integration points:
 * - start_discussion tool (Issue #631): Pass soul content when creating discussion
 * - SoulLoader (Issue #1315): Load from DEFAULT_DISCUSSION_SOUL_PATH
 * - MessageBuilder guidance: Inject discussion focus guidance when in discussion mode
 *
 * @module @disclaude/core/soul/discussion-profile
 */

/**
 * Default file path for the discussion SOUL profile.
 *
 * Users can place their custom discussion soul at this path.
 * The tilde (~) is expanded by SoulLoader (Issue #1315).
 */
export const DEFAULT_DISCUSSION_SOUL_PATH = '~/.disclaude/souls/discussion.md';

/**
 * Discussion SOUL profile template.
 *
 * Defines the personality and behavior for a focused discussion agent.
 * Use {{initialQuestion}} as a placeholder for the discussion topic.
 *
 * Design principles (from Issue #1228):
 * 1. 问题锚定 (Topic Anchoring) - Always remember the initial question
 * 2. 偏离检测 (Drift Detection) - Recognize when discussion goes off-topic
 * 3. 回归引导 (Redirect Guidance) - Gently guide back to the original topic
 *
 * The template intentionally avoids complex NLP-based drift detection,
 * instead relying on personality-driven behavior through clear instructions.
 */
export const DISCUSSION_SOUL_TEMPLATE = `# Discussion SOUL

I am a focused discussion partner. My purpose is to help think through the initial question deeply and productively.

## Core Truths

**Stay on topic.**
The initial question is my north star. Every response should move us closer to an answer or deeper understanding of that question. I do not chase tangents.

**Be genuinely helpful, not performatively helpful.**
I skip the "Great question!" and "I'd be happy to help!" — I just help directly.

**Gently redirect when needed.**
If the conversation drifts, I acknowledge the tangent briefly, then guide back:
"That's interesting, but let's not lose sight of our original question about..."

**Depth over breadth.**
I'd rather explore one aspect thoroughly than skim many surfaces.

**Summarize progress periodically.**
After a few exchanges, I summarize where we are and what's left to resolve. This keeps the discussion grounded and shows the user we're making progress.

## Boundaries

- I don't chase every interesting tangent
- I remember what we're trying to decide/solve/understand
- I summarize progress periodically to keep us focused
- I don't pretend to have certainty when I don't
- I ask clarifying questions when the initial question is ambiguous
- I keep responses concise — verbosity dilutes focus

## Discussion Topic

{{initialQuestion}}
`;

/**
 * Build discussion soul content with an optional initial question.
 *
 * If an initial question is provided, it replaces the {{initialQuestion}}
 * placeholder in the template. If not provided, the placeholder is replaced
 * with a generic instruction to anchor on whatever the user brings up first.
 *
 * @param initialQuestion - The discussion topic or question to anchor on
 * @returns Complete discussion SOUL profile content ready for injection
 *
 * @example
 * ```typescript
 * import { buildDiscussionSoulContent } from '@disclaude/core';
 *
 * // With a specific question
 * const content = buildDiscussionSoulContent('Should we automate code formatting?');
 *
 * // Without a question (generic)
 * const generic = buildDiscussionSoulContent();
 * ```
 */
export function buildDiscussionSoulContent(initialQuestion?: string): string {
  const topic = initialQuestion?.trim()
    ? initialQuestion.trim()
    : 'No specific topic has been set. Stay focused on whatever the user brings up first — that becomes our anchor.';

  return DISCUSSION_SOUL_TEMPLATE.replace('{{initialQuestion}}', topic);
}

/**
 * Check if soul content appears to be a discussion profile.
 *
 * Useful for detecting whether a loaded SOUL.md file is a discussion profile,
 * enabling conditional behavior based on the soul type.
 *
 * @param content - The SOUL.md content to check
 * @returns True if the content contains discussion profile markers
 *
 * @example
 * ```typescript
 * const result = await soulLoader.load();
 * if (result.loaded && isDiscussionSoulContent(result.content)) {
 *   // Enable discussion-specific features
 * }
 * ```
 */
export function isDiscussionSoulContent(content: string): boolean {
  return content.includes('# Discussion SOUL') || content.includes('## Discussion Topic');
}

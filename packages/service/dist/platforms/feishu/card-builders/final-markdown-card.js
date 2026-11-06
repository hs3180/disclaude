/**
 * Final-answer Markdown card for the automatic Claude/Codex reply path (#5487).
 *
 * The `## Sources` path in {@link ./citation-card.ts} is a strict contract and
 * stays first. This helper covers the remaining final Markdown answers that
 * contain at least one GFM table: Feishu card Markdown does not render `| col |`
 * syntax, so those replies must become Card 2.0 markdown + `column_set`
 * elements instead of leaking raw pipe text.
 *
 * Narrow eligibility is deliberate:
 * - table-free Markdown keeps the existing text/streaming delivery;
 * - standalone valid JSON keeps the exact requested raw format;
 * - any `## Sources` header is left to the citation contract (a malformed
 *   section must keep the historical plain-text fallback, not become a generic
 *   card and silently drop the citation semantics);
 * - tables inside fenced code blocks are already excluded by the shared parser.
 *
 * Delivery boundaries own budget/retry semantics: this module only builds JSON.
 *
 * @module platforms/feishu/card-builders/final-markdown-card
 */
import { normalizeMarkdownLineBreaks } from './content-builder.js';
import { markdownToCardElements, splitMarkdownByTables } from './gfm-table-converter.js';
import { STREAMING_THINKING_ELEMENT_ID } from './streaming-card-builder.js';
/** Exact section header owned by the citation contract. */
const SOURCES_HEADER_PATTERN = /(?:^|\n)## Sources(?:\r?\n|$)/u;
function eligibleFinalMarkdown(text) {
    const normalized = normalizeMarkdownLineBreaks(text);
    if (!splitMarkdownByTables(normalized).some((segment) => segment.type === 'table')) {
        return null;
    }
    if (SOURCES_HEADER_PATTERN.test(normalized)) {
        return null;
    }
    try {
        JSON.parse(normalized);
        return null;
    }
    catch {
        // Ordinary Markdown that merely contains pipe characters is not JSON.
    }
    return normalized;
}
/**
 * Build a Card 2.0 replacement for a table-bearing final Markdown answer.
 *
 * @returns Card JSON, or null when the reply is not eligible (see module doc).
 */
export function buildFinalMarkdownCard(text) {
    const normalized = eligibleFinalMarkdown(text);
    if (normalized === null) {
        return null;
    }
    return {
        schema: '2.0',
        config: { update_multi: true },
        body: { elements: markdownToCardElements(normalized) },
    };
}
/**
 * Build the final Card 2.0 update for an in-flight streaming card, preserving
 * the existing thinking element id and replacing the streamed Markdown with
 * markdown/column_set elements in the same Card Kit message.
 *
 * @returns Streaming card JSON, or null when the reply is not eligible.
 */
export function buildFinalMarkdownStreamingCard(text) {
    const normalized = eligibleFinalMarkdown(text);
    if (normalized === null) {
        return null;
    }
    return {
        schema: '2.0',
        config: { streaming_mode: true },
        body: {
            elements: [
                {
                    tag: 'markdown',
                    element_id: STREAMING_THINKING_ELEMENT_ID,
                    content: '本次回复已结束',
                },
                ...markdownToCardElements(normalized),
            ],
        },
    };
}

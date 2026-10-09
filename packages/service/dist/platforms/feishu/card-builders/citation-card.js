/**
 * Deterministic `## Sources` citation card for #5193.
 *
 * Narrow-contract counterpart to the Codex citation prompt: the model only
 * promises a strictly formatted trailing `## Sources` section in its final
 * markdown answer; this module deterministically detects, parses, and renders
 * it. JSON construction, escaping, and delivery stay in service code — the
 * model never handwrites card JSON or invokes channel tools (review on #5227).
 *
 * Failure policy: any deviation from the contract makes {@link extractCitations}
 * return null and the message is delivered through the legacy plain-text path.
 * The channel only retries a card as text after a definite Feishu rejection;
 * transport/server errors with unknown delivery outcome are propagated to avoid
 * sending a duplicate.
 */
import { normalizeMarkdownLineBreaks } from './content-builder.js';
import { buildStreamingPlaceholderCard } from './streaming-card-builder.js';
/** Exact section header the prompt contract asks for. */
const SOURCES_HEADER = '## Sources';
/** Entry line: `7. [Title](https://…)`, single line, direct http(s) URL. */
const ENTRY_PATTERN = /^(\d{1,3})\.\s+\[(.+)\]\((https?:\/\/[^\s)]+)\)\s*$/;
/** Excerpt line: a blockquote indented no deeper than a list continuation. */
const EXCERPT_PATTERN = /^\s{0,3}>\s?(.*)$/;
/**
 * Require the parsed source entries to match the body's citation markers in
 * first-appearance order. A malformed model answer stays readable Markdown;
 * the adapter must never silently attach a different source to a claim.
 */
function sourceOrderMatchesBody(body, sources) {
    const firstAppearance = [];
    const seen = new Set();
    for (const match of body.matchAll(/(?<!\\)\[(\d{1,3})\]/g)) {
        const number = Number(match[1]);
        if (number < 1) {
            return false;
        }
        if (!seen.has(number)) {
            seen.add(number);
            firstAppearance.push(number);
        }
    }
    return (firstAppearance.length === sources.length &&
        firstAppearance.every((number, index) => number === sources[index]?.number));
}
function renderSourceEntries(sources) {
    return sources.map((source) => {
        const title = source.title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        const link = `[${source.number}] [${title}](${source.url})`;
        return source.excerpt ? `${link}\n> ${source.excerpt.replace(/\n/g, '\n> ')}` : link;
    });
}
/**
 * Strictly parse a trailing `## Sources` section.
 *
 * Contract (anything else → null, i.e. legacy plain-text delivery):
 * - The last `## Sources` line starts the section and only whitespace may
 *   precede it in the section scan; nothing but the parsed entries may follow.
 * - Each entry is `N. [title](url)` on its own line; blank lines between
 *   entries are allowed; an optional blockquote excerpt may follow.
 * - Entry numbers must be unique (they align with body markers, so the written
 *   number is authoritative; sequence gaps are tolerated). Every body marker
 *   must have one entry, and entries must follow each source's first appearance.
 * - The body before the header must be non-empty.
 *
 * @param text - Full outgoing message text (already newline-normalized).
 * @returns Parsed body + sources, or null when the contract is not met.
 */
export function extractCitations(text) {
    const lines = text.split('\n');
    // Section header must exist and everything after the LAST occurrence must
    // parse — an earlier `## Sources` mentioned mid-answer stays part of the body.
    let headerIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trimEnd() === SOURCES_HEADER) {
            headerIndex = i;
            break;
        }
    }
    if (headerIndex === -1) {
        return null;
    }
    const body = lines.slice(0, headerIndex).join('\n').trimEnd();
    if (!body.trim()) {
        return null;
    }
    const sources = [];
    const seenNumbers = new Set();
    let current = null;
    const excerptLines = [];
    const flushExcerpt = () => {
        if (current && excerptLines.length > 0) {
            current.excerpt = excerptLines.join('\n').trimEnd();
        }
        excerptLines.length = 0;
    };
    for (let i = headerIndex + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') {
            continue; // blank lines between entries are cosmetic
        }
        const entry = ENTRY_PATTERN.exec(line);
        if (entry) {
            flushExcerpt();
            const number = Number(entry[1]);
            const title = entry[2].trim();
            let parsedUrl;
            try {
                parsedUrl = new URL(entry[3]);
            }
            catch {
                return null;
            }
            if (number < 1 ||
                !title ||
                !parsedUrl.hostname ||
                parsedUrl.username ||
                parsedUrl.password ||
                seenNumbers.has(number)) {
                return null; // invalid entry or duplicate marker → ambiguous alignment, reject
            }
            seenNumbers.add(number);
            current = { number, title, url: entry[3] };
            sources.push(current);
            continue;
        }
        const excerpt = EXCERPT_PATTERN.exec(line);
        if (excerpt && current) {
            excerptLines.push(excerpt[1]);
            continue;
        }
        return null; // anything else breaks the contract → legacy delivery
    }
    flushExcerpt();
    if (sources.length === 0) {
        return null;
    }
    if (!sourceOrderMatchesBody(body, sources)) {
        return null;
    }
    return { body, sources };
}
/**
 * Build the single interactive card that carries the answer AND its sources.
 *
 * JSON-1.0 card (`wide_screen_mode`, root `elements`) matching the shapes the
 * channel already sends for `msg_type: 'interactive'` (e.g. `case 'card'`).
 * One message → body markers and source numbers stay aligned by construction;
 * all string escaping happens in `JSON.stringify` at the send boundary, never
 * in model-authored JSON.
 *
 * @param body - Answer body (without the `## Sources` section).
 * @param sources - Parsed entries; rendered in written order.
 * @returns Feishu interactive card payload.
 */
export function buildCitationCard(body, sources) {
    const entries = renderSourceEntries(sources);
    return {
        config: {
            wide_screen_mode: true,
        },
        elements: [
            {
                tag: 'markdown',
                content: normalizeMarkdownLineBreaks(body),
            },
            { tag: 'hr' },
            {
                tag: 'markdown',
                content: `**Sources**\n${entries.join('\n')}`,
            },
        ],
    };
}
/**
 * Build the final JSON-2.0 version of a streaming answer card with citations.
 * The stream already shows this answer; replacing the card at finalization
 * keeps its message identity while separating the answer from its sources.
 */
export function buildCitationStreamingCard(body, sources) {
    const sourceBlock = `**Sources**\n${renderSourceEntries(sources).join('\n')}`;
    return buildStreamingPlaceholderCard({
        thinkingPlaceholder: '本次回复已结束',
        replyText: `${normalizeMarkdownLineBreaks(body)}\n\n---\n\n${sourceBlock}`,
    });
}

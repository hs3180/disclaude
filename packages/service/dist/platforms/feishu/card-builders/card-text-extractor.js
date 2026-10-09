/**
 * Card Text Extractor.
 *
 * Extracts user-visible text content from a Feishu Card structure.
 * Issue #1231: Only persist what the user actually sees, not the full JSON.
 */
/**
 * Helper: extract text from a Feishu text object (plain_text / lark_md).
 */
function extractTextValue(text) {
    if (typeof text === 'string') {
        return text;
    }
    if (text && typeof text === 'object') {
        const obj = text;
        return obj.content || obj.text || '';
    }
    return '';
}
/**
 * Recursively extract all user-visible text parts from card elements (full content).
 */
function extractFullFromElements(elements) {
    const parts = [];
    for (const element of elements) {
        if (!element || typeof element !== 'object') {
            continue;
        }
        const el = element;
        if (el.tag === 'markdown' && typeof el.content === 'string' && el.content.trim()) {
            parts.push(el.content.trim());
        }
        if (el.tag === 'div') {
            const text = extractTextValue(el.text);
            if (text.trim()) {
                parts.push(text.trim());
            }
        }
        if (el.tag === 'note') {
            const content = typeof el.content === 'string' ? el.content : extractTextValue(el.text);
            if (content?.trim()) {
                parts.push(content.trim());
            }
        }
        if (el.tag === 'button') {
            const btnText = extractTextValue(el.text);
            if (btnText.trim()) {
                parts.push(`[${btnText.trim()}]`);
            }
        }
        if (Array.isArray(el.elements)) {
            parts.push(...extractFullFromElements(el.elements));
        }
        if (Array.isArray(el.actions)) {
            parts.push(...extractFullFromElements(el.actions));
        }
        if (Array.isArray(el.columns)) {
            for (const column of el.columns) {
                if (column && typeof column === 'object') {
                    const col = column;
                    if (Array.isArray(col.elements)) {
                        parts.push(...extractFullFromElements(col.elements));
                    }
                }
            }
        }
    }
    return parts;
}
/**
 * Extract text from `<card title="...">content</card>` format.
 * Issue #4083: Feishu sometimes delivers card messages in this XML-like format
 * instead of the structured JSON template format.
 */
function extractCardTagContent(content) {
    const match = content.match(/^<card[^>]*>([\s\S]*)<\/card>$/);
    if (!match) {
        return null;
    }
    const body = match[1].trim();
    if (!body) {
        return null;
    }
    // Try to extract title attribute
    const titleMatch = content.match(/^<card[^>]*\btitle="([^"]*)"[^>]*>/);
    const title = titleMatch ? `**${titleMatch[1]}**\n` : '';
    return title + body;
}
/**
 * Extract full user-visible text content from a Feishu Card for agent consumption.
 * Issue #3657: Returns complete card content (not truncated).
 * Issue #4083: Also handles `<card>` string format.
 *
 * @param card - Feishu card object or `<card>` string content
 * @returns Structured text representation of the card
 */
export function extractFullCardContent(card) {
    // Issue #4083: Handle `<card title="...">content</card>` format
    if (typeof card === 'string') {
        return extractCardTagContent(card) || '[Interactive Card]';
    }
    const lines = [];
    // Header
    const header = card.header;
    if (header?.title?.content) {
        lines.push(`**${header.title.content}**`);
    }
    // Elements
    const elements = card.elements;
    if (Array.isArray(elements)) {
        lines.push(...extractFullFromElements(elements));
    }
    return lines.length > 0 ? lines.join('\n') : '[Interactive Card]';
}
/**
 * Extract user-visible text content from a Feishu Card structure.
 *
 * @param card - Feishu card object
 * @returns Extracted text content for logging
 */
export function extractCardTextContent(card) {
    const textParts = [];
    // Extract header title if present
    const header = card.header;
    if (header?.title?.content) {
        textParts.push(`[${header.title.content}]`);
    }
    // Recursively extract text from elements
    const extractFromElements = (elements) => {
        for (const element of elements) {
            if (!element || typeof element !== 'object') {
                continue;
            }
            const el = element;
            // Extract from markdown content
            if (el.tag === 'markdown' && typeof el.content === 'string') {
                // Only take first line or first 100 chars for brevity
                const content = el.content.split('\n')[0]?.slice(0, 100) || '';
                if (content.trim()) {
                    textParts.push(content.trim());
                }
            }
            // Extract from plain text
            if (el.tag === 'div' && typeof el.text === 'string') {
                textParts.push(el.text.trim());
            }
            // Extract from note
            if (el.tag === 'note' && typeof el.content === 'string') {
                const content = el.content.split('\n')[0]?.slice(0, 100) || '';
                if (content.trim()) {
                    textParts.push(content.trim());
                }
            }
            // Extract from button text
            if (el.tag === 'button' && el.text) {
                const text = el.text?.content;
                if (text) {
                    textParts.push(`[${text}]`);
                }
            }
            // Recursively process nested elements
            if (Array.isArray(el.elements)) {
                extractFromElements(el.elements);
            }
            // Process actions array
            if (Array.isArray(el.actions)) {
                extractFromElements(el.actions);
            }
            // Process columns (for column_set layout)
            if (Array.isArray(el.columns)) {
                for (const column of el.columns) {
                    if (column && typeof column === 'object') {
                        const col = column;
                        if (Array.isArray(col.elements)) {
                            extractFromElements(col.elements);
                        }
                    }
                }
            }
        }
    };
    // Start extraction from card elements
    const elements = card.elements;
    if (Array.isArray(elements)) {
        extractFromElements(elements);
    }
    // If we found text content, return it; otherwise return a generic description
    if (textParts.length > 0) {
        // Limit to first 3 items to keep log concise
        const parts = textParts.slice(0, 3);
        return `[Interactive Card] ${parts.join(' | ')}`;
    }
    return '[Interactive Card]';
}

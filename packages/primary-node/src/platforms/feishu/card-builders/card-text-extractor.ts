/**
 * Card Text Extractor.
 *
 * Extracts user-visible text content from a Feishu Card structure.
 * Issue #1231: Only persist what the user actually sees, not the full JSON.
 */

/**
 * Extract user-visible text content from a Feishu Card structure.
 *
 * @param card - Feishu card object
 * @returns Extracted text content for logging
 */
export function extractCardTextContent(card: Record<string, unknown>): string {
  const textParts: string[] = [];

  // Extract header title if present
  const header = card.header as { title?: { content?: string } } | undefined;
  if (header?.title?.content) {
    textParts.push(`[${header.title.content}]`);
  }

  // Recursively extract text from elements
  const extractFromElements = (elements: unknown[]): void => {
    for (const element of elements) {
      if (!element || typeof element !== 'object') {
        continue;
      }

      const el = element as Record<string, unknown>;

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
        const text = (el.text as { content?: string })?.content;
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
            const col = column as Record<string, unknown>;
            if (Array.isArray(col.elements)) {
              extractFromElements(col.elements);
            }
          }
        }
      }
    }
  };

  // Start extraction from card elements
  const elements = card.elements as unknown[] | undefined;
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

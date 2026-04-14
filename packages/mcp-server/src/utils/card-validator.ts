/**
 * Feishu card validation utilities.
 *
 * @module mcp/utils/card-validator
 */

/**
 * Check if content is a valid Feishu interactive card structure.
 */
export function isValidFeishuCard(content: Record<string, unknown>): boolean {
  return (
    typeof content === 'object' &&
    content !== null &&
    'config' in content &&
    'header' in content &&
    'elements' in content &&
    Array.isArray(content.elements) &&
    typeof content.header === 'object' &&
    content.header !== null &&
    'title' in content.header
  );
}

/**
 * Detect GFM table syntax in card markdown elements and return warnings.
 *
 * Feishu card markdown elements do NOT support GFM table syntax (| col | col |).
 * This function scans card elements for markdown content containing table syntax
 * and returns warning messages to guide the agent toward using column_set instead.
 *
 * @param card - The card JSON structure to check
 * @returns Array of warning strings (empty if no issues found)
 *
 * @see https://github.com/hs3180/disclaude/issues/2340
 * @see https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set
 */
export function detectMarkdownTableWarnings(card: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const {elements} = card;

  if (!Array.isArray(elements)) {return warnings;}

  for (const element of elements) {
    if (
      typeof element === 'object' &&
      element !== null &&
      'tag' in element &&
      (element as Record<string, unknown>).tag === 'markdown' &&
      typeof (element as Record<string, unknown>).content === 'string'
    ) {
      const content = (element as Record<string, unknown>).content as string;
      if (containsGfmTable(content)) {
        warnings.push(
          'Card markdown element contains GFM table syntax (| col |), which is NOT supported by Feishu cards. ' +
          'The table will render as raw pipe text. Use column_set elements for tabular data instead. ' +
          'See: https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set',
        );
      }
    }
  }

  return warnings;
}

/**
 * Check if a string contains GFM table syntax.
 *
 * Detects the separator row pattern (|---|---|) which is the most reliable
 * indicator of a markdown table. Also detects two or more consecutive pipe-delimited rows.
 *
 * @param content - The markdown content string to check
 * @returns true if GFM table syntax is detected
 */
export function containsGfmTable(content: string): boolean {
  const lines = content.split('\n');

  // Fast path: look for separator row (|---|---| or |:---:|:---:|)
  // This is the most reliable table indicator
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(trimmed)) {
      return true;
    }
  }

  // Slower path: look for consecutive pipe-delimited rows
  let consecutivePipeRows = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.+\|\s*$/.test(trimmed) && trimmed.split('|').filter(Boolean).length >= 2) {
      consecutivePipeRows++;
      if (consecutivePipeRows >= 3) {
        return true;
      }
    } else {
      consecutivePipeRows = 0;
    }
  }

  return false;
}

/**
 * Get detailed validation error for an invalid card.
 *
 * Issue #1355: Improved error messages to help AI agents understand and fix
 * parameter format issues (e.g., passing string instead of object).
 */
export function getCardValidationError(content: unknown): string {
  if (content === null) {
    return 'card is null - must be an object with config/header/elements';
  }
  if (typeof content !== 'object') {
    return `card is ${typeof content} - must be an object with config/header/elements`;
  }
  if (Array.isArray(content)) {
    return 'card is an array - must be an object with config/header/elements, not an array';
  }

  const obj = content as Record<string, unknown>;
  const missing: string[] = [];
  const wrongTypes: string[] = [];

  if (!('config' in obj)) {
    missing.push('config');
  } else if (typeof obj.config !== 'object' || obj.config === null) {
    wrongTypes.push('config must be an object');
  }

  if (!('header' in obj)) {
    missing.push('header');
  } else if (typeof obj.header !== 'object' || obj.header === null) {
    wrongTypes.push('header must be an object with title');
  }

  if (!('elements' in obj)) {
    missing.push('elements');
  } else if (!Array.isArray(obj.elements)) {
    wrongTypes.push('elements must be an array');
  }

  if (missing.length > 0) {
    return `missing required fields: ${missing.join(', ')}`;
  }

  if (wrongTypes.length > 0) {
    return wrongTypes.join('; ');
  }

  if (typeof obj.header === 'object' && obj.header !== null && !('title' in obj.header)) {
    return 'header.title is missing';
  }

  return 'invalid card structure - ensure card has config (object), header (object with title), and elements (array)';
}

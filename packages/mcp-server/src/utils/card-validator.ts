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
 * Parse a GFM table string into structured data.
 *
 * Extracts headers and rows from a markdown table string that uses the
 * separator row pattern (|---|---|).
 *
 * @param content - The markdown content potentially containing a table
 * @returns Parsed table data, or null if no valid table found
 *
 * @see https://github.com/hs3180/disclaude/issues/2340
 */
export function parseGfmTable(content: string): {
  headers: string[];
  rows: string[][];
  before: string;
  after: string;
} | null {
  const lines = content.split('\n');
  const separatorRegex = /^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/;
  const dataRowRegex = /^\|.+\|\s*$/;

  let separatorIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (separatorRegex.test(lines[i].trim())) {
      separatorIndex = i;
      break;
    }
  }

  if (separatorIndex < 1) {
    return null;
  }

  // Header is the row before separator
  const headerLine = lines[separatorIndex - 1].trim();
  if (!dataRowRegex.test(headerLine)) {
    return null;
  }

  const headers = parsePipeRow(headerLine);
  if (headers.length < 2) {
    return null;
  }

  // Data rows follow the separator
  const rows: string[][] = [];
  let dataEndIndex = separatorIndex + 1;
  for (let i = separatorIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (dataRowRegex.test(trimmed) && !separatorRegex.test(trimmed)) {
      const cells = parsePipeRow(trimmed);
      // Pad or truncate to match header count
      while (cells.length < headers.length) {
        cells.push('');
      }
      rows.push(cells.slice(0, headers.length));
      dataEndIndex = i + 1;
    } else {
      break;
    }
  }

  if (rows.length === 0) {
    return null;
  }

  const before = lines.slice(0, separatorIndex - 1).join('\n');
  const after = lines.slice(dataEndIndex).join('\n');

  return { headers, rows, before, after };
}

/**
 * Parse a pipe-delimited row into an array of cell values.
 *
 * @param line - A pipe-delimited line like "| a | b | c |"
 * @returns Array of trimmed cell values
 */
function parsePipeRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)  // Remove empty strings from leading/trailing pipes
    .map(cell => cell.trim());
}

/**
 * Convert parsed GFM table data into a Feishu column_set element.
 *
 * Each column contains a bold header followed by data rows stacked vertically.
 * This produces a side-by-side layout that renders correctly in Feishu cards.
 *
 * @param headers - Table column headers
 * @param rows - Table data rows
 * @returns A column_set card element
 *
 * @see https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set
 */
export function gfmTableToColumnSet(
  headers: string[],
  rows: string[][],
): Record<string, unknown> {
  const columns = headers.map((_header, colIndex) => {
    const headerText = headers[colIndex];
    const dataTexts = rows.map(row => row[colIndex] || '');

    const elements: Array<Record<string, unknown>> = [
      { tag: 'markdown', content: `**${headerText}**` },
    ];

    for (const data of dataTexts) {
      elements.push({ tag: 'markdown', content: data });
    }

    return {
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'top' as const,
      elements,
    };
  });

  return {
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'default',
    columns,
  };
}

/**
 * Process a card's elements, converting GFM tables in markdown to column_set.
 *
 * Scans all markdown elements for GFM table syntax. When found:
 * 1. Parses the table
 * 2. Converts to column_set
 * 3. Preserves surrounding non-table markdown content
 * 4. Replaces the original element with the converted elements
 *
 * @param card - The card JSON structure to process (modified in place)
 * @returns Object with conversion count and any remaining warnings
 *
 * @see https://github.com/hs3180/disclaude/issues/2340
 */
export function convertCardTables(card: Record<string, unknown>): {
  converted: number;
  warnings: string[];
} {
  const result = { converted: 0, warnings: [] as string[] };

  const { elements } = card;
  if (!Array.isArray(elements)) {
    return result;
  }

  const newElements: unknown[] = [];

  for (const element of elements) {
    if (
      typeof element !== 'object' ||
      element === null ||
      !('tag' in element) ||
      (element as Record<string, unknown>).tag !== 'markdown' ||
      typeof (element as Record<string, unknown>).content !== 'string'
    ) {
      newElements.push(element);
      continue;
    }

    const content = (element as Record<string, unknown>).content as string;

    if (!containsGfmTable(content)) {
      newElements.push(element);
      continue;
    }

    const parsed = parseGfmTable(content);
    if (!parsed) {
      // Table detected but couldn't parse — keep warning
      result.warnings.push(
        'Card markdown element contains GFM table syntax that could not be auto-converted. ' +
        'The table will render as raw pipe text. Use column_set elements for tabular data instead.',
      );
      newElements.push(element);
      continue;
    }

    // Add text before the table (if any non-whitespace content)
    if (parsed.before.trim()) {
      newElements.push({ tag: 'markdown', content: parsed.before.trim() });
    }

    // Add the converted column_set
    newElements.push(gfmTableToColumnSet(parsed.headers, parsed.rows));
    result.converted++;

    // Add text after the table (if any non-whitespace content)
    if (parsed.after.trim()) {
      newElements.push({ tag: 'markdown', content: parsed.after.trim() });
    }
  }

  card.elements = newElements;
  return result;
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

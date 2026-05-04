/**
 * GFM table to Feishu column_set converter.
 *
 * Automatically converts GFM markdown tables found in card markdown elements
 * into Feishu column_set elements, which are properly rendered in cards.
 *
 * Feishu card markdown elements do NOT support GFM table syntax (| col | col |).
 * This module provides transparent auto-conversion so agents can include tables
 * without manually constructing column_set structures.
 *
 * @see https://github.com/hs3180/disclaude/issues/2340
 * @see https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set
 *
 * @module mcp-server/utils/table-converter
 */

/**
 * Parsed GFM table structure.
 */
export interface ParsedGfmTable {
  headers: string[];
  rows: string[][];
  /** Text before the table (may be empty) */
  prefix: string;
  /** Text after the table (may be empty) */
  suffix: string;
}

/**
 * Parse GFM table from markdown content.
 *
 * Extracts the first GFM table found in the content and returns
 * its headers, rows, and any surrounding text.
 *
 * @param content - Markdown content that may contain a GFM table
 * @returns Parsed table or null if no valid table found
 */
export function parseGfmTable(content: string): ParsedGfmTable | null {
  const lines = content.split('\n');

  // Find the separator row (|---|---| or |:---:|:---:|)
  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\|[\s\-:]+(\|[\s\-:]+)+\|?\s*$/.test(trimmed)) {
      separatorIdx = i;
      break;
    }
  }

  if (separatorIdx === -1) {
    return null;
  }

  // The header row must be immediately before the separator
  if (separatorIdx === 0) {
    return null;
  }

  const headerLine = lines[separatorIdx - 1].trim();
  const headers = parsePipeRow(headerLine);
  if (headers.length < 2) {
    return null;
  }

  // Parse data rows after separator
  const rows: string[][] = [];
  let dataEndIdx = separatorIdx + 1;
  for (let i = separatorIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\|.+\|\s*$/.test(trimmed) && trimmed.split('|').filter(Boolean).length >= 2) {
      rows.push(parsePipeRow(trimmed));
      dataEndIdx = i + 1;
    } else {
      break;
    }
  }

  if (rows.length === 0) {
    return null;
  }

  const prefix = lines.slice(0, separatorIdx - 1).join('\n').trim();
  const suffix = lines.slice(dataEndIdx).join('\n').trim();

  return { headers, rows, prefix, suffix };
}

/**
 * Parse a pipe-delimited row into cell values.
 *
 * @param line - A single pipe-delimited line (e.g., "| a | b | c |")
 * @returns Array of trimmed cell values
 */
function parsePipeRow(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1) // Remove leading/trailing empty segments from |...|
    .map(cell => cell.trim());
}

/**
 * Build Feishu column_set elements from parsed table data using row-oriented layout.
 *
 * Follows best practices from Issue #3277:
 * - Header row as separate column_set with grey background
 * - Each data row as its own column_set with default background
 * - Equal-weight columns for balanced layout
 * - bisect flex_mode for 2-4 columns, trisection for more
 * - vertical_align: center for proper alignment
 *
 * @param headers - Column header strings
 * @param rows - Row data (each row is an array of cell strings)
 * @returns Array of Feishu column_set element objects (header + one per data row)
 *
 * @see https://github.com/hs3180/disclaude/issues/3277
 * @see https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set
 */
export function buildTableColumnSets(headers: string[], rows: string[][]): Record<string, unknown>[] {
  const colCount = headers.length;
  const flexMode = colCount <= 4 ? 'bisect' : 'trisection';

  // Header row with grey background
  const headerColumns = headers.map(header => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'center',
    elements: [{ tag: 'markdown', content: `**${header}**` }],
  }));

  const headerSet: Record<string, unknown> = {
    tag: 'column_set',
    flex_mode: flexMode,
    background_style: 'grey',
    columns: headerColumns,
  };

  // Data rows with default background (one column_set per row)
  const dataSets: Record<string, unknown>[] = rows.map(row => ({
    tag: 'column_set',
    flex_mode: flexMode,
    background_style: 'default',
    columns: headers.map((_header, colIdx) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [{ tag: 'markdown', content: colIdx < row.length ? (row[colIdx] || ' ') : ' ' }],
    })),
  }));

  return [headerSet, ...dataSets];
}

/**
 * @deprecated Use buildTableColumnSets() instead, which returns row-oriented layout
 * with proper header styling per Issue #3277 best practices.
 */
export function buildColumnSet(headers: string[], rows: string[][]): Record<string, unknown> {
  // Merge all into single column_set for backward compatibility
  const colCount = headers.length;
  const flexMode = colCount <= 4 ? 'bisect' : 'trisection';

  const allColumns = headers.map((_header, colIdx) => {
    const elements: Array<Record<string, unknown>> = [];
    elements.push({ tag: 'markdown', content: `**${headers[colIdx]}**` });
    for (const row of rows) {
      const cellContent = colIdx < row.length ? row[colIdx] : '';
      elements.push({ tag: 'markdown', content: cellContent || ' ' });
    }
    return { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements };
  });

  return {
    tag: 'column_set',
    flex_mode: flexMode,
    background_style: 'default',
    columns: allColumns,
  };
}

/**
 * Transform a Feishu card by converting GFM tables in markdown elements to column_set.
 *
 * Scans all elements in the card. For each markdown element containing a GFM table:
 * 1. Parses the table
 * 2. Builds a column_set element
 * 3. Replaces the original markdown element with:
 *    - A markdown element for prefix text (if any)
 *    - The column_set element
 *    - A markdown element for suffix text (if any)
 *
 * @param card - The card JSON structure
 * @returns New card with tables converted (original card is not mutated)
 */
export function transformCardTables(card: Record<string, unknown>): Record<string, unknown> {
  const {elements} = card;
  if (!Array.isArray(elements)) {
    return card;
  }

  let hasChanges = false;
  const newElements: unknown[] = [];

  for (const element of elements) {
    if (
      typeof element === 'object' &&
      element !== null &&
      'tag' in element &&
      (element as Record<string, unknown>).tag === 'markdown' &&
      typeof (element as Record<string, unknown>).content === 'string'
    ) {
      const content = (element as Record<string, unknown>).content as string;
      const parsed = parseGfmTable(content);

      if (parsed) {
        hasChanges = true;

        // Add prefix text as separate markdown element (if non-empty)
        if (parsed.prefix) {
          newElements.push({
            tag: 'markdown',
            content: parsed.prefix,
          });
        }

        // Add column_set elements (header row + one per data row)
        newElements.push(...buildTableColumnSets(parsed.headers, parsed.rows));

        // Add suffix text as separate markdown element (if non-empty)
        if (parsed.suffix) {
          newElements.push({
            tag: 'markdown',
            content: parsed.suffix,
          });
        }

        continue;
      }
    }

    // Keep original element if no table found
    newElements.push(element);
  }

  if (!hasChanges) {
    return card;
  }

  // Return new card with transformed elements
  return { ...card, elements: newElements };
}

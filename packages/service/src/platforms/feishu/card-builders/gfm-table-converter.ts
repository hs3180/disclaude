/**
 * GFM table to Feishu column_set converter.
 *
 * Feishu card markdown elements do NOT support GFM table syntax (`| col |`).
 * This module converts tables found in card markdown elements into
 * column_set structures so host auto-built cards (citation cards, streaming
 * finals) render tables natively instead of leaking raw pipe text (#5473).
 *
 * column_set is a Feishu card structure, so this converter is deliberately a
 * LOCAL implementation of the Feishu channel (review on #5486) — not a shared
 * core/messaging export. channel-cli's `send_card` keeps its own independent
 * copy (`channel-cli/src/utils/table-converter.ts`); the two evolve separately.
 *
 * Parsing rules (#5473):
 * - Converts EVERY table in a markdown element (not just the first).
 * - Fenced code blocks are never scanned — a `|---|` inside ``` stays literal.
 * - `\|` escapes a pipe inside cells; the escape is unwrapped on conversion.
 * - Expansion into column_set happens only at the card's element roots
 *   (JSON-1.0 `elements` / JSON-2.0 `body.elements`): column_set nested inside
 *   column/div containers is not a valid Feishu structure. Markdown elements
 *   nested in containers keep their content untouched.
 *
 * @see https://github.com/hs3180/disclaude/issues/2340
 * @see https://github.com/hs3180/disclaude/issues/5473
 * @see https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/using-column-set
 *
 * @module platforms/feishu/card-builders/gfm-table-converter
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

/** A markdown chunk between tables (cells escaped content preserved as-is). */
export interface MarkdownTextSegment {
  type: 'text';
  text: string;
}

/** One parsed table with `\|` escapes already unwrapped in cells. */
export interface MarkdownTableSegment {
  type: 'table';
  headers: string[];
  rows: string[][];
}

export type MarkdownSegment = MarkdownTextSegment | MarkdownTableSegment;

/** Fence marker (``` or ~~~) at line start (GFM allows up to 3 leading spaces). */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Split markdown content into alternating text and table segments.
 *
 * Tables follow GFM: a header row, a separator row (`---`/`:--:` per cell),
 * and at least one data row. Fenced code blocks are skipped entirely.
 *
 * @param content - Markdown content that may contain GFM tables
 * @returns Segments in order; a single text segment when no table is found
 */
export function splitMarkdownByTables(content: string): MarkdownSegment[] {
  const lines = content.split('\n');
  const segments: MarkdownSegment[] = [];
  let textLines: string[] = [];
  let fence: string | null = null;

  const flushText = (): void => {
    const text = textLines.join('\n').trim();
    if (text) {
      segments.push({ type: 'text', text });
    }
    textLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = FENCE_PATTERN.exec(line);
    if (fence || fenceMatch) {
      if (fence && fenceMatch && fenceMatch[1][0] === fence[0] && !fenceMatch[2].trim()) {
        fence = null; // closing fence of the same marker type
      } else if (!fence && fenceMatch) {
        fence = fenceMatch[1].charAt(0);
      }
      textLines.push(line);
      continue;
    }

    const table = tryParseTableAt(lines, i);
    if (table) {
      flushText();
      segments.push({ type: 'table', headers: table.headers, rows: table.rows });
      i = table.endIndex; // loop increment moves past the last table row
      continue;
    }
    textLines.push(line);
  }
  flushText();

  return segments;
}

/**
 * Try to parse a GFM table whose header row is at `startIndex`.
 *
 * @returns Parsed cells plus the index of the last consumed line, or null.
 */
function tryParseTableAt(
  lines: string[],
  startIndex: number
): { headers: string[]; rows: string[][]; endIndex: number } | null {
  const headerCells = splitPipeCells(lines[startIndex]);
  if (headerCells.length < 2 || headerCells.every((cell) => cell === '')) {
    return null;
  }

  const separatorCells = splitPipeCells(lines[startIndex + 1] ?? '');
  if (
    separatorCells.length !== headerCells.length ||
    separatorCells.some((cell) => !/^:?-{1,}:?$/.test(cell))
  ) {
    return null;
  }

  const rows: string[][] = [];
  let endIndex = startIndex + 1;
  for (let i = startIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!containsUnescapedPipe(line) || line.trim() === '') {
      break;
    }
    if (FENCE_PATTERN.test(line)) {
      break;
    }
    const cells = splitPipeCells(line);
    if (cells.length < 1) {
      break;
    }
    rows.push(cells);
    endIndex = i;
  }

  if (rows.length === 0) {
    return null;
  }
  return { headers: headerCells, rows, endIndex };
}

/**
 * Split a pipe row into trimmed cell values, honoring `\|` escapes.
 *
 * Leading/trailing pipes contribute empty edge cells which are dropped, so
 * both `| a | b |` and `| a | b` (and `a | b`) yield `['a', 'b']`. Escapes are
 * unwrapped (`a\|b` → `a|b`) — Feishu cell markdown renders the literal pipe.
 */
function splitPipeCells(line: string): string[] {
  const raw: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      raw.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  raw.push(current);

  if (raw.length > 1 && raw[0].trim() === '') {
    raw.shift();
  }
  if (raw.length > 1 && raw[raw.length - 1].trim() === '') {
    raw.pop();
  }
  return raw.map((cell) => cell.trim());
}

function containsUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      i++;
      continue;
    }
    if (line[i] === '|') {
      return true;
    }
  }
  return false;
}

/**
 * Parse the first GFM table found in markdown content.
 *
 * @param content - Markdown content that may contain a GFM table
 * @returns Parsed table or null if no valid table found
 * @deprecated Use {@link splitMarkdownByTables}, which handles every table,
 *   code fences, and escaped pipes. Kept for `send_card` compatibility.
 */
export function parseGfmTable(content: string): ParsedGfmTable | null {
  const segments = splitMarkdownByTables(content);
  const tableIdx = segments.findIndex((segment) => segment.type === 'table');
  if (tableIdx === -1) {
    return null;
  }
  const table = segments[tableIdx] as MarkdownTableSegment;
  const textBefore = segments
    .slice(0, tableIdx)
    .filter((s): s is MarkdownTextSegment => s.type === 'text')
    .map((s) => s.text);
  const textAfter = segments
    .slice(tableIdx + 1)
    .filter((s): s is MarkdownTextSegment => s.type === 'text')
    .map((s) => s.text);
  return {
    headers: table.headers,
    rows: table.rows,
    prefix: textBefore.join('\n\n'),
    suffix: textAfter.join('\n\n'),
  };
}

/**
 * Build Feishu column_set elements from parsed table data using row-oriented
 * layout (header row as grey column_set, one column_set per data row).
 *
 * @see https://github.com/hs3180/disclaude/issues/3277
 */
export function buildTableColumnSets(
  headers: string[],
  rows: string[][]
): Record<string, unknown>[] {
  const colCount = headers.length;
  const flexMode = colCount <= 2 ? 'bisect' : 'trisection';

  // Header row with grey background
  const headerColumns = headers.map((header) => ({
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
  const dataSets: Record<string, unknown>[] = rows.map((row) => ({
    tag: 'column_set',
    flex_mode: flexMode,
    background_style: 'default',
    columns: headers.map((_header, colIdx) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      vertical_align: 'center',
      elements: [{ tag: 'markdown', content: colIdx < row.length ? row[colIdx] || ' ' : ' ' }],
    })),
  }));

  return [headerSet, ...dataSets];
}

/**
 * @deprecated Use buildTableColumnSets() instead, which returns row-oriented
 * layout with proper header styling per Issue #3277 best practices.
 */
export function buildColumnSet(headers: string[], rows: string[][]): Record<string, unknown> {
  // Merge all into single column_set for backward compatibility
  const colCount = headers.length;
  const flexMode = colCount <= 2 ? 'bisect' : 'trisection';

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
 * Split one markdown string into card elements, converting every GFM table.
 *
 * Text segments (trimmed, non-empty) become markdown elements in order; each
 * table becomes its column_set group. Empty input yields an empty array.
 */
export function markdownToCardElements(content: string): Array<Record<string, unknown>> {
  const elements: Array<Record<string, unknown>> = [];
  for (const segment of splitMarkdownByTables(content)) {
    if (segment.type === 'text') {
      elements.push({ tag: 'markdown', content: segment.text });
    } else {
      elements.push(...buildTableColumnSets(segment.headers, segment.rows));
    }
  }
  return elements;
}

/**
 * Transform a Feishu card by converting GFM tables in markdown elements to
 * column_set.
 *
 * Covers both card schemas: JSON-1.0 root `elements` and JSON-2.0
 * `body.elements` (#5473). Every table in a root-level markdown element is
 * converted; markdown elements nested inside containers (column/div/…) keep
 * their content — column_set is not a valid child there.
 *
 * @param card - The card JSON structure
 * @returns New card with tables converted (the original card is not mutated;
 *   the same reference is returned when nothing changed)
 */
export function transformCardTables(card: Record<string, unknown>): Record<string, unknown> {
  const roots: Array<{ key: string; elements: unknown[] }> = [];
  const { elements, body } = card as { elements?: unknown; body?: unknown };
  if (Array.isArray(elements)) {
    roots.push({ key: 'elements', elements });
  }
  const bodyElements = (body as Record<string, unknown> | undefined)?.elements;
  if (Array.isArray(bodyElements)) {
    roots.push({ key: 'body', elements: bodyElements });
  }
  if (roots.length === 0) {
    return card;
  }

  let hasChanges = false;
  const transformed: Record<string, unknown> = { ...card };
  for (const root of roots) {
    const result = mapCardElements(root.elements);
    if (result.changed) {
      hasChanges = true;
      if (root.key === 'body') {
        transformed.body = {
          ...((body as Record<string, unknown>) ?? {}),
          elements: result.elements,
        };
      } else {
        transformed.elements = result.elements;
      }
    }
  }

  return hasChanges ? transformed : card;
}

/**
 * Walk one element-root array, expanding tables in its markdown elements.
 * Nested content passes through untouched (see module doc).
 */
function mapCardElements(elements: unknown[]): { elements: unknown[]; changed: boolean } {
  let changed = false;
  const mapped: unknown[] = [];

  for (const element of elements) {
    if (typeof element !== 'object' || element === null) {
      mapped.push(element);
      continue;
    }
    const record = element as Record<string, unknown>;

    if (
      record.tag === 'markdown' &&
      typeof record.content === 'string' &&
      containsTable(record.content)
    ) {
      mapped.push(...markdownToCardElements(record.content));
      changed = true;
      continue;
    }

    // Everything else — including containers with nested elements arrays —
    // passes through: expansion only happens at element roots (module doc).
    mapped.push(element);
  }

  return { elements: changed ? mapped : elements, changed };
}

function containsTable(content: string): boolean {
  return splitMarkdownByTables(content).some((segment) => segment.type === 'table');
}

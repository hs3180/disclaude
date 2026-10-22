/**
 * Deprecated re-export shim (#5473).
 *
 * The GFM table → Feishu column_set converter moved to
 * `@disclaude/core` (`core/messaging/gfm-table-converter`) so the service
 * package can share it without depending on the CLI. Import from
 * `@disclaude/core` directly; this file only keeps the historical
 * `channel-cli/utils/table-converter` import path working.
 *
 * @module channel-cli/utils/table-converter
 */
export {
  parseGfmTable,
  buildTableColumnSets,
  buildColumnSet,
  markdownToCardElements,
  splitMarkdownByTables,
  transformCardTables,
} from '@disclaude/core';
export type {
  ParsedGfmTable,
  MarkdownSegment,
  MarkdownTextSegment,
  MarkdownTableSegment,
} from '@disclaude/core';

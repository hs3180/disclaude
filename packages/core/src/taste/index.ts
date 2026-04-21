/**
 * TasteManager module — auto-summarized user taste (preferences) persistence.
 *
 * @see Issue #2335 (feat: auto-summarize user taste)
 */

export type {
  TasteResult,
  TasteSource,
  TasteCategory,
  TasteRule,
  TasteData,
  TasteRuleEntry,
  TasteManagerOptions,
} from './types.js';

export {
  CATEGORY_LABELS,
  TASTE_CATEGORIES,
  TASTE_SOURCES,
} from './types.js';

export { TasteManager } from './taste-manager.js';

/**
 * TasteManager module — per-project user preference auto-summarization.
 *
 * Stores user preferences (taste) that the agent learns and follows
 * automatically, avoiding repeated corrections across sessions.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

// Types
export type {
  AddRuleOptions,
  FormattedTasteRule,
  TasteCategory,
  TasteData,
  TasteFilter,
  TasteManagerOptions,
  TasteRule,
  TasteSource,
} from './types.js';

export {
  CATEGORY_LABELS,
  SOURCE_LABELS,
} from './types.js';

// Core class
export { TasteManager } from './taste-manager.js';

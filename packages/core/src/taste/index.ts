/**
 * TasteManager module — auto-detect and persist user preferences.
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 * @module taste
 */

export { TasteManager } from './taste-manager.js';
export type {
  TasteData,
  TasteRule,
  TasteCategory,
  TasteSource,
  TasteManagerOptions,
  AddTasteRuleOptions,
  RecordCorrectionOptions,
  ListTasteRulesOptions,
} from './types.js';
export { TASTE_VERSION, TASTE_CATEGORY_LABELS } from './types.js';

/**
 * TasteManager module — user taste (preference) management for projects.
 *
 * @see Issue #2335 (auto-summarize user taste)
 */

export type {
  TasteResult,
  TasteRule,
  TasteSource,
  TastePersistData,
  TasteManagerOptions,
  AddTasteRuleOptions,
} from './types.js';

export { TasteCategory } from './types.js';

export { TasteManager } from './taste-manager.js';

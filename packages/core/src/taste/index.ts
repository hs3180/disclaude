/**
 * Taste module — user preference persistence and context injection.
 *
 * @see Issue #2335
 * @module taste
 */

// Types
export type {
  TasteCategory,
  TasteSource,
  TasteRule,
  TastePersistData,
  TasteManagerOptions,
  TasteResult,
} from './types.js';

// Constants
export {
  TASTE_CATEGORIES,
  TASTE_CATEGORY_LABELS,
} from './types.js';

// Core class
export { TasteManager } from './taste-manager.js';

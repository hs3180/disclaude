/**
 * TasteManager module — auto-summarize user taste (preference) management.
 *
 * @see Issue #2335 (parent — auto-summarize user taste)
 */

export type {
  TasteResult,
  TasteCategory,
  TasteSource,
  TasteEntry,
  TasteManagerOptions,
  TastePersistData,
  CorrectionSignal,
} from './types.js';

export { TasteManager } from './taste-manager.js';

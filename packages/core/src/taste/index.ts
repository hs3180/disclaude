/**
 * Taste module — User preference auto-summarization.
 *
 * Automatically detects and stores user preferences from chat history
 * to avoid repeated corrections across sessions.
 *
 * @see Issue #2335
 * @module taste
 */

export type {
  TasteCategory,
  TasteSource,
  TasteRule,
  TasteProfile,
  TasteResult,
  TasteSummary,
  DetectedPattern,
} from './types.js';

export {
  getTastePath,
  serializeToYaml,
  parseFromYaml,
  readTasteProfile,
  writeTasteProfile,
  deleteTasteProfile,
  mergePatterns,
  addManualRule,
  removeRule,
  getActiveRules,
  getSummary,
  formatTasteForContext,
} from './taste-store.js';

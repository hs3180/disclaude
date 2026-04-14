/**
 * Taste module — auto-summarized user preferences.
 *
 * Automatically detects, persists, and injects user preferences (taste)
 * into Agent context to avoid repeated corrections.
 *
 * Architecture:
 * - types.ts: Type definitions for taste rules and data
 * - taste-loader.ts: YAML persistence (load/save)
 * - taste-detector.ts: Pattern detection and prompt generation
 *
 * Integration points:
 * - daily-chat-review skill: calls scanLogForCorrections() to detect taste
 * - MessageBuilder: calls buildTastePromptSection() to inject taste
 * - Future /taste command: manages taste rules
 *
 * @see https://github.com/hs3180/disclaude/issues/2335
 */

export type {
  TasteCategory,
  TasteRule,
  TasteSource,
  TasteData,
  DetectedCorrection,
  TasteResult,
} from './types.js';

export {
  loadTaste,
  saveTaste,
  getTasteFilePath,
  createEmptyTasteData,
} from './taste-loader.js';

export {
  categorizeCorrection,
  mergeTasteRules,
  scanLogForCorrections,
  buildTastePromptSection,
} from './taste-detector.js';

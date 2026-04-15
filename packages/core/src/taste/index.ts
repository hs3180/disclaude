/**
 * Taste module — auto-summarized user preferences for Agent context.
 *
 * Provides file-based persistence and prompt injection for user taste
 * preferences, so the Agent follows learned preferences without
 * requiring repeated corrections.
 *
 * Phase 1: Core data model, persistence, and guidance injection.
 * Future: Auto-detection from chat patterns, per-project isolation,
 * management commands (/taste list, /taste edit, /taste reset).
 *
 * @see Issue #2335 — auto-summarize user taste to avoid repeated corrections
 */

// Types
export type {
  TasteSource,
  TasteCategory,
  TasteRule,
  TasteProfile,
  TasteStoreOptions,
  TasteResult,
} from './types.js';

// Store
export { TasteStore } from './taste-store.js';

// Guidance (for prompt injection)
export {
  buildTasteGuidance,
  getCategoryLabel,
} from './guidance.js';

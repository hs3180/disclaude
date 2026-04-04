/**
 * Knowledge module - Project instructions and knowledge base loading.
 *
 * Issue #1916: Claude Projects-like knowledge base functionality.
 *
 * @module knowledge
 */

export {
  loadKnowledge,
  formatKnowledgeForPrompt,
} from './knowledge-loader.js';

export type {
  KnowledgeFileEntry,
  LoadedKnowledge,
} from './knowledge-loader.js';

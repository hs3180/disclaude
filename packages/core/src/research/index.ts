/**
 * Research Module
 *
 * Provides RESEARCH.md file management for research sessions.
 * Handles the full lifecycle: initialization, auto-update, and archiving.
 *
 * @module research
 */

// Types
export type {
  ResearchFileManagerConfig,
  ResearchInitOptions,
  ResearchFinding,
  ResearchQuestion,
  ResearchResource,
  ParsedResearch,
} from './research-file.js';

// Research File Manager
export {
  ResearchFileManager,
  isValidTopic,
  sanitizeTopic,
} from './research-file.js';

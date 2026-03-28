/**
 * Research Module — RESEARCH.md lifecycle management.
 *
 * Provides ResearchFileManager for creating, updating, reading,
 * and archiving RESEARCH.md state files during research mode sessions.
 *
 * Issue #1710: 实现 RESEARCH.md 研究状态文件
 * Depends on: #1709 (Research Mode)
 *
 * @module research
 */

// Types
export type {
  ResearchFileManagerConfig,
  ResearchInitOptions,
  ResearchFinding,
  ResearchResource,
  ParsedResearch,
} from './research-file.js';

// Research File Manager
export {
  ResearchFileManager,
  isValidTopic,
  buildTemplate,
  formatFinding,
  appendToSection,
  replaceSection,
  insertSection,
  parseContent,
} from './research-file.js';

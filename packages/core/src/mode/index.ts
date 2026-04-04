/**
 * Mode module - Agent mode switching and research file management.
 *
 * Issue #1709: Research Mode - SOUL + cwd + Skill set switching.
 * Issue #1710: RESEARCH.md research state file.
 *
 * Provides:
 * - Research file management (template, parse, update, archive)
 *
 * Note: ModeManager and related types from Issue #1709 will be
 * added here when that PR merges.
 *
 * @module mode
 */

// Research File (Issue #1710)
export {
  createInitialResearchFile,
  generateResearchMarkdown,
  parseResearchMarkdown,
  addFinding,
  addOpenQuestion,
  resolveOpenQuestion,
  setConclusion,
  addResource,
  addObjective,
  completeObjective,
  archiveResearch,
  type ResearchFileData,
  type ResearchFinding,
  type ResearchResource,
  type ResearchMetadata,
  type CreateResearchOptions,
  type AddFindingOptions,
  type ArchiveResult,
} from './research-file.js';

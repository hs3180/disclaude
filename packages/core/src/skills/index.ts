/**
 * Skills module - Skill discovery and management.
 */

export {
  type DiscoveredSkill,
  type SkillSearchPath,
  getDefaultSearchPaths,
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
} from './finder.js';

export {
  type ResearchStatus,
  type ParsedResearchStatus,
  type ResearchNoteOptions,
  type ResearchConclusionOptions,
  RESEARCH_STATUS_MARKERS,
  RESEARCH_STATUS_LABELS,
  generateInitialResearchMd,
  parseResearchStatus,
  generateConclusionSection,
  updateResearchStatus,
} from './research-note.js';

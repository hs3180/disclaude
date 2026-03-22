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
  type DiscoveredSoul,
  type SoulLevel,
  type FindSoulOptions,
  type SoulContent,
  type SoulLifecycle,
  getSoulSearchPaths,
  findSoul,
  loadSoul,
  mergeSouls,
  loadMergedSoul,
  formatSoulForPrompt,
} from './soul-loader.js';

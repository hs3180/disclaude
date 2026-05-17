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
  type SkillMetadata,
  type MatchedSkillResult,
  matchSkills,
  buildSkillInjection,
  invalidateCache,
} from './auto-trigger.js';

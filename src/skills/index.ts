/**
 * Skills Module - Simple skill discovery for Agent SDK.
 *
 * This module provides a simple skill file discovery system as described in Issue #430:
 *
 * - Find skill markdown files across multiple search paths
 * - No YAML parsing - just return file paths
 * - Support project, workspace, and package domains
 *
 * Design Principles:
 * - Simple and minimal - no complex parsing
 * - Just find and return file paths
 * - Let SkillAgent read the markdown content
 *
 * @example
 * ```typescript
 * import { findSkill, listSkills } from './skills/index.js';
 *
 * // Find a specific skill
 * const skillPath = await findSkill('evaluator');
 * // Returns: '/path/to/skills/evaluator/SKILL.md'
 *
 * // List all available skills
 * const skills = await listSkills();
 * // Returns: [{ name: 'evaluator', path: '...', domain: 'package' }, ...]
 *
 * // Read skill content
 * const content = await readSkillContent('evaluator');
 * ```
 *
 * @module skills
 */

export {
  findSkill,
  listSkills,
  skillExists,
  readSkillContent,
  getDefaultSearchPaths,
  type DiscoveredSkill,
  type SkillSearchPath,
} from './finder.js';

export {
  createSkillFromChat,
  listUserSkills,
  deleteUserSkill,
  type CreateSkillOptions,
  type CreateSkillResult,
} from './creator.js';

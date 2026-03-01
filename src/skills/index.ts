/**
 * Skills Module - Generic skill support for Agent SDK.
 *
 * This module provides a simple skill loading system as described in Issue #430:
 *
 * - Load skill markdown files from the file system
 * - Parse YAML frontmatter for metadata
 * - Search for skills across multiple paths
 *
 * Design Principles:
 * - Simple and minimal - no complex parsing
 * - Just read markdown files and extract basic metadata
 * - Works with any Agent implementation
 *
 * @example
 * ```typescript
 * import { FileSystemSkillLoader } from './skills/index.js';
 *
 * const loader = new FileSystemSkillLoader();
 *
 * // Load a single skill
 * const skill = await loader.loadSkill('skills/evaluator/SKILL.md');
 * console.log(skill.name); // 'evaluator'
 * console.log(skill.allowedTools); // ['Read', 'Grep', 'Glob', 'Write']
 *
 * // Search across multiple paths
 * const skills = await loader.searchSkills([
 *   { path: '.claude/skills', domain: 'project', priority: 3 },
 *   { path: 'skills', domain: 'package', priority: 1 },
 * ]);
 * ```
 *
 * @module skills
 */

export { FileSystemSkillLoader } from './loader.js';
export type {
  Skill,
  SkillLoader,
  SkillSearchPath,
  SkillFrontmatter,
} from './types.js';

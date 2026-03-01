/**
 * Skills Module - Generic skill support for Agent SDK.
 *
 * This module provides a simple skill loading system as described in Issue #430:
 *
 * - Load skill markdown files from the file system
 * - Parse YAML frontmatter for metadata
 * - Search for skills across multiple paths
 * - Inject skills into Agent system prompts
 *
 * Design Principles:
 * - Simple and minimal - no complex parsing
 * - Just read markdown files and extract basic metadata
 * - Works with any Agent implementation
 *
 * @example
 * ```typescript
 * import { FileSystemSkillLoader, ClaudeCodeSkillProvider } from './skills/index.js';
 *
 * // Using the loader directly
 * const loader = new FileSystemSkillLoader();
 * const skill = await loader.loadSkill('skills/evaluator/SKILL.md');
 * console.log(skill.name); // 'evaluator'
 * console.log(skill.allowedTools); // ['Read', 'Grep', 'Glob', 'Write']
 *
 * // Using the provider for Agent integration
 * const provider = new ClaudeCodeSkillProvider();
 * const result = await provider.loadSkillsForAgent('evaluator');
 * console.log(result.allowedTools); // ['Read', 'Grep', 'Glob', 'Write']
 * console.log(result.systemPromptContent); // Skill content for system prompt
 * ```
 *
 * @module skills
 */

export { FileSystemSkillLoader } from './loader.js';
export { ClaudeCodeSkillProvider } from './provider.js';
export type {
  Skill,
  SkillLoader,
  SkillSearchPath,
  SkillFrontmatter,
} from './types.js';
export type {
  SkillLoadContext,
  SkillProviderOptions,
  LoadedSkills,
} from './provider.js';

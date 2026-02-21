/**
 * Skill file loader and parser.
 *
 * ## Skill as Behavior Pattern
 *
 * This module implements the "Skill as Behavior" pattern where:
 * - Skill frontmatter defines tool access and metadata
 * - Skill content (when present) provides agent's system prompt (static behavior)
 * - Runtime prompts provide task-specific instructions (dynamic context)
 *
 * ## Task Skill for Pilot
 *
 * **Task skill uses a direct prompt template**:
 * - Task skill's prompt structure is explicitly defined in code (not from skill files)
 * - The skill file is still required for frontmatter (allowed-tools, etc.)
 * - This ensures the task skill's prompt template is stable and predictable
 *
 * ## Separation of Concerns
 *
 * **SKILL.md files (this module)**:
 * - Define "who the agent is" (stable identity)
 * - Agent role, responsibilities, tools
 * - Behavioral guidelines and workflows
 * - Output format requirements
 * - Loaded once during agent.initialize()
 *
 * **Runtime prompts (dialogue-bridge.ts)**:
 * - Define "what to do now" (current task)
 * - Task-specific context and instructions
 * - Iteration-specific directives
 * - Generated dynamically per request
 *
 * **Direct templates**:
 * - Task skill uses a direct template for its runtime prompt
 * - Ensures stability and predictability of prompt structure
 *
 * ## Key Benefits
 *
 * 1. **Single Source of Truth**: Agent behavior defined once in SKILL.md
 * 2. **No Redundancy**: Runtime prompts don't repeat static behavior
 * 3. **Maintainability**: Change behavior in one place
 * 4. **Efficiency**: Smaller runtime prompts = less token usage
 * 5. **Stability**: Direct templates won't change unexpectedly
 *
 * ## File Format
 *
 * SKILL.md files use YAML frontmatter for metadata:
 * ```yaml
 * ---
 * name: worker
 * description: Task execution specialist...
 * disable-model-invocation: false
 * allowed-tools: Read, Write, Glob, Grep, Bash
 * ---
 *
 * # Agent Role
 *
 * Detailed behavior description here...
 * ```
 *
 * **Note**: Task skill file is required for frontmatter only,
 * as its prompt template is defined in code.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('SkillLoader');

/**
 * Parsed skill data extracted from SKILL.md file.
 */
export interface ParsedSkill {
  /** Skill name from frontmatter */
  name: string;
  /** Skill description from frontmatter */
  description: string;
  /** Whether model invocation is disabled */
  disableModelInvocation: boolean;
  /** List of allowed tools from frontmatter */
  allowedTools: string[];
  /** Markdown content after frontmatter (used as system prompt) */
  content: string;
}

/**
 * Result of loading a skill file.
 */
export interface SkillLoadResult {
  /** Whether the skill was loaded successfully */
  success: boolean;
  /** Parsed skill data (only if success=true) */
  skill?: ParsedSkill;
  /** Error message (only if success=false) */
  error?: string;
}

/**
 * Parse YAML frontmatter from skill content.
 *
 * Extracts:
 * - name
 * - description
 * - disable-model-invocation
 * - allowed-tools (both comma-separated and array formats)
 *
 * @param content - Raw skill file content
 * @returns Parsed frontmatter and content start position
 */
function parseSkillFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  contentStart: number;
} {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, contentStart: 0 };
  }

  const [, frontmatterText] = match;
  const frontmatter: Record<string, unknown> = {};

  // Parse key-value pairs
  const lines = frontmatterText.split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {continue;}

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    switch (key) {
      case 'name':
      case 'description':
        frontmatter[key] = value;
        break;
      case 'disable-model-invocation':
        frontmatter['disableModelInvocation'] = value === 'true';
        break;
      case 'allowed-tools':
        // Could be comma-separated or array format
        if (value.startsWith('[')) {
          // Array format - parse later
          frontmatter[key] = value;
        } else {
          // Comma-separated
          frontmatter['allowedTools'] = value.split(',')
            .map(t => t.trim())
            .filter(t => t.length > 0);
        }
        break;
    }
  }

  // Handle array format for allowed-tools: [tool1, tool2, tool3]
  if (!frontmatter['allowedTools'] && frontmatter['allowed-tools']) {
    const arrayValue = String(frontmatter['allowed-tools']);
    const match = arrayValue.match(/\[(.*?)\]/s);
    if (match) {
      frontmatter['allowedTools'] = match[1]
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
    }
  }

  return {
    frontmatter,
    contentStart: match[0].length
  };
}

/**
 * Load a skill file from .claude/skills directory.
 *
 * @param skillName - Name of the skill directory (e.g., "task")
 * @returns Parsed skill data or error
 */
export async function loadSkill(skillName: string): Promise<SkillLoadResult> {
  try {
    const skillsBaseDir = Config.getSkillsDir();
    const skillPath = path.join(
      skillsBaseDir,
      skillName,
      'SKILL.md'
    );

    logger.debug({ skillName, skillPath }, 'Loading skill file');

    const content = await fs.readFile(skillPath, 'utf-8');
    const { frontmatter, contentStart } = parseSkillFrontmatter(content);

    const skillContent = content.slice(contentStart).trim();

    const skill: ParsedSkill = {
      name: (frontmatter['name'] as string) || skillName,
      description: (frontmatter['description'] as string) || '',
      disableModelInvocation: (frontmatter['disableModelInvocation'] as boolean) ?? false,
      allowedTools: (frontmatter['allowedTools'] as string[]) || [],
      content: skillContent,
    };

    logger.info({
      skillName: skill.name,
      toolCount: skill.allowedTools.length,
      contentLength: skillContent.length,
    }, 'Skill loaded successfully');

    return { success: true, skill };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, skillName }, 'Failed to load skill');

    return {
      success: false,
      error: errorMessage
    };
  }
}

/**
 * Load a skill file and throw error if it fails.
 * Use this when skill is required (no fallback).
 *
 * @param skillName - Name of the skill directory
 * @returns Parsed skill data
 * @throws Error if skill loading fails
 */
export async function loadSkillOrThrow(skillName: string): Promise<ParsedSkill> {
  const result = await loadSkill(skillName);

  if (!result.success || !result.skill) {
    throw new Error(
      `Required skill "${skillName}" failed to load. ` +
      `Error: ${result.error || 'Unknown error'}. ` +
      `Please ensure skills directory is configured and ${skillName}/SKILL.md exists.`
    );
  }

  return result.skill;
}


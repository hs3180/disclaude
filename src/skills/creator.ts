/**
 * Skill Creator - Create skills from chat history.
 *
 * This module implements Issue #448: 利用聊天记录快速学会用户指令技能
 * - Create skills from conversation learning moments
 * - Parse chat history to extract learning content
 * - Generate SKILL.md files in workspace
 *
 * @module skills/creator
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { messageLogger } from '../feishu/message-logger.js';

const logger = createLogger('SkillCreator');

/**
 * Options for creating a skill.
 */
export interface CreateSkillOptions {
  /** Skill name (used for directory name) */
  name: string;
  /** Chat ID to extract history from */
  chatId: string;
  /** Optional description (auto-generated if not provided) */
  description?: string;
  /** Optional skill content (auto-extracted if not provided) */
  content?: string;
}

/**
 * Result of skill creation.
 */
export interface CreateSkillResult {
  /** Whether creation was successful */
  success: boolean;
  /** Path to created SKILL.md file */
  skillPath?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Sanitize skill name for use as directory name.
 *
 * @param name - Raw skill name
 * @returns Sanitized name (lowercase, alphanumeric with hyphens)
 */
function sanitizeSkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 64); // Max 64 characters
}

/**
 * Generate a skill description from chat history.
 *
 * @param chatHistory - Raw chat history markdown
 * @returns Generated description
 */
function generateDescription(chatHistory: string): string {
  // Extract key learning patterns from chat history
  const lines = chatHistory.split('\n');

  // Look for patterns like "以后就这样做", "记住这个", etc.
  const learningPatterns = [
    /以后.*这样做/,
    /记住/,
    /记住这个/,
    /下次/,
    /按照这个/,
    /遵循/,
    /按照以下/,
    /使用这个/,
  ];

  let detectedPattern = '';
  for (const line of lines) {
    for (const pattern of learningPatterns) {
      if (pattern.test(line)) {
        detectedPattern = line.trim().substring(0, 100);
        break;
      }
    }
    if (detectedPattern) {
      break;
    }
  }

  if (detectedPattern) {
    return `User-defined skill: ${detectedPattern}`;
  }

  return 'Custom skill created from conversation';
}

/**
 * Extract learning content from chat history.
 *
 * @param chatHistory - Raw chat history markdown
 * @returns Extracted learning content
 */
function extractLearningContent(chatHistory: string): string {
  const sections = chatHistory.split('---');
  const recentMessages = sections.slice(-10); // Last 10 message blocks

  // Extract user messages (📥 User)
  const userMessages: string[] = [];
  for (const section of recentMessages) {
    if (section.includes('📥 User')) {
      // Extract content after the header
      const lines = section.split('\n');
      let inContent = false;
      let content = '';

      for (const line of lines) {
        if (inContent && line.trim()) {
          content = `${content}${line}\n`;
        }
        if (line.startsWith('**Type**:')) {
          inContent = true;
        }
      }

      if (content.trim()) {
        userMessages.push(content.trim());
      }
    }
  }

  // Combine user messages to form the skill content
  if (userMessages.length > 0) {
    return `# Instructions\n\nBased on user guidance from conversation:\n\n${userMessages.map((m, i) => `${i + 1}. ${m}`).join('\n\n')}`;
  }

  return '# Instructions\n\nCustom skill content from conversation.';
}

/**
 * Create a skill from chat history.
 *
 * @param options - Skill creation options
 * @returns Creation result
 */
export async function createSkillFromChat(options: CreateSkillOptions): Promise<CreateSkillResult> {
  const { name, chatId, description, content } = options;

  try {
    // Validate name
    if (!name || name.trim().length === 0) {
      return { success: false, error: 'Skill name is required' };
    }

    const sanitizedName = sanitizeSkillName(name);
    if (sanitizedName.length < 2) {
      return { success: false, error: 'Skill name too short (min 2 characters after sanitization)' };
    }

    // Get chat history
    const chatHistory = await messageLogger.getChatHistory(chatId);

    if (!chatHistory || chatHistory.trim().length === 0) {
      return { success: false, error: 'No chat history found for this conversation' };
    }

    // Generate skill content
    const skillDescription = description || generateDescription(chatHistory);
    const skillContent = content || extractLearningContent(chatHistory);

    // Determine skill directory path (workspace/.claude/skills/)
    const workspaceDir = Config.getWorkspaceDir();
    const skillDir = path.join(workspaceDir, '.claude', 'skills', sanitizedName);
    const skillFilePath = path.join(skillDir, 'SKILL.md');

    // Check if skill already exists
    try {
      await fs.access(skillFilePath);
      return { success: false, error: `Skill "${sanitizedName}" already exists. Use a different name or delete the existing skill first.` };
    } catch {
      // File doesn't exist, proceed
    }

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Generate SKILL.md content
    const skillMd = `---
name: ${sanitizedName}
description: ${skillDescription}
user-invocable: true
---

${skillContent}

---
*Created from chat ${chatId} on ${new Date().toISOString()}*
`;

    // Write SKILL.md file
    await fs.writeFile(skillFilePath, skillMd, 'utf-8');

    logger.info({ skillPath: skillFilePath, chatId, name: sanitizedName }, 'Skill created from chat history');

    return {
      success: true,
      skillPath: skillFilePath,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, chatId, name }, 'Failed to create skill from chat');
    return { success: false, error: errorMessage };
  }
}

/**
 * List user-created skills in workspace.
 *
 * @returns Array of skill names
 */
export async function listUserSkills(): Promise<string[]> {
  const workspaceDir = Config.getWorkspaceDir();
  const skillsDir = path.join(workspaceDir, '.claude', 'skills');

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    const skills: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillFile = path.join(skillsDir, entry.name, 'SKILL.md');
        try {
          await fs.access(skillFile);
          skills.push(entry.name);
        } catch {
          // No SKILL.md, skip
        }
      }
    }

    return skills;
  } catch {
    return [];
  }
}

/**
 * Delete a user-created skill.
 *
 * @param name - Skill name to delete
 * @returns Deletion result
 */
export async function deleteUserSkill(name: string): Promise<CreateSkillResult> {
  const sanitizedName = sanitizeSkillName(name);
  const workspaceDir = Config.getWorkspaceDir();
  const skillDir = path.join(workspaceDir, '.claude', 'skills', sanitizedName);

  try {
    // Check if skill exists
    const skillFilePath = path.join(skillDir, 'SKILL.md');
    try {
      await fs.access(skillFilePath);
    } catch {
      return { success: false, error: `Skill "${sanitizedName}" not found` };
    }

    // Delete the skill directory
    await fs.rm(skillDir, { recursive: true, force: true });

    logger.info({ skillDir, name: sanitizedName }, 'User skill deleted');

    return { success: true, skillPath: skillFilePath };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, name: sanitizedName }, 'Failed to delete user skill');
    return { success: false, error: errorMessage };
  }
}

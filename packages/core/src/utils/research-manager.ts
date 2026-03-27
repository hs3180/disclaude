/**
 * Research workspace manager.
 *
 * Manages isolated research workspaces with automatic RESEARCH.md
 * state file creation and maintenance.
 *
 * Issue #1707: Research Mode — Phase 1 (Research workspace + RESEARCH.md)
 *
 * Directory structure:
 *   workspace/
 *     research/
 *       {topic}/
 *         RESEARCH.md    — Research state file (auto-maintained)
 *         notes/         — Optional: research notes and artifacts
 *         sources/       — Optional: collected source materials
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('ResearchManager');

/** Default directory name for research workspaces under workspace root. */
export const RESEARCH_DIR_NAME = 'research';

/** Default filename for research state files. */
export const RESEARCH_FILE_NAME = 'RESEARCH.md';

/** Optional sub-directories created within a research workspace. */
export const RESEARCH_SUB_DIRS = ['notes', 'sources'] as const;

/**
 * Options for creating a new research workspace.
 */
export interface CreateResearchOptions {
  /** Research topic description (used as directory name and in RESEARCH.md) */
  topic: string;
  /** Optional research objective / goal */
  objective?: string;
  /** Optional initial context or background information */
  context?: string;
}

/**
 * Parsed section from RESEARCH.md.
 */
export interface ResearchSection {
  /** Section heading (without # prefix) */
  heading: string;
  /** Section content (trimmed) */
  content: string;
}

/**
 * Resolve the research root directory.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @returns Absolute path to `workspace/research/`
 */
export function getResearchRootDir(workspaceDir: string): string {
  return path.resolve(workspaceDir, RESEARCH_DIR_NAME);
}

/**
 * Resolve the directory path for a specific research topic.
 *
 * The topic is sanitized to produce a safe directory name:
 * - Lowercased
 * - Spaces replaced with hyphens
 * - Non-alphanumeric characters (except hyphens) removed
 * - Maximum 64 characters
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic (will be sanitized for use as directory name)
 * @returns Absolute path to `workspace/research/{sanitized-topic}/`
 */
export function getResearchDir(workspaceDir: string, topic: string): string {
  const sanitized = sanitizeTopicName(topic);
  return path.resolve(workspaceDir, RESEARCH_DIR_NAME, sanitized);
}

/**
 * Resolve the RESEARCH.md file path for a specific topic.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @returns Absolute path to `workspace/research/{topic}/RESEARCH.md`
 */
export function getResearchFilePath(workspaceDir: string, topic: string): string {
  return path.join(getResearchDir(workspaceDir, topic), RESEARCH_FILE_NAME);
}

/**
 * Get the cwd for a research session (the research topic directory).
 *
 * This value can be passed as `extra.cwd` to `createSdkOptions()`
 * to scope agent file operations to the research workspace.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @returns Absolute path to the research topic directory
 */
export function getResearchCwd(workspaceDir: string, topic: string): string {
  return getResearchDir(workspaceDir, topic);
}

/**
 * Create a new research workspace with initial RESEARCH.md file.
 *
 * Creates the directory structure:
 *   workspace/research/{topic}/
 *   workspace/research/{topic}/RESEARCH.md
 *   workspace/research/{topic}/notes/
 *   workspace/research/{topic}/sources/
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param options - Research creation options
 * @returns Absolute path to the created research directory
 * @throws {Error} If topic is empty or workspace directory is invalid
 */
export async function createResearchWorkspace(
  workspaceDir: string,
  options: CreateResearchOptions,
): Promise<string> {
  const { topic, objective, context } = options;

  if (!topic || topic.trim().length === 0) {
    throw new Error('Research topic is required');
  }

  const researchDir = getResearchDir(workspaceDir, topic);
  const researchFile = getResearchFilePath(workspaceDir, topic);

  // Create main research directory
  await fs.mkdir(researchDir, { recursive: true });

  // Create optional sub-directories
  for (const subDir of RESEARCH_SUB_DIRS) {
    await fs.mkdir(path.join(researchDir, subDir), { recursive: true });
  }

  // Generate and write RESEARCH.md
  const content = generateResearchFileContent(topic, { objective, context });
  await fs.writeFile(researchFile, content, 'utf-8');

  logger.info(
    { researchDir, topic, hasObjective: !!objective, hasContext: !!context },
    'Research workspace created',
  );

  return researchDir;
}

/**
 * Read the RESEARCH.md file for a specific topic.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @returns File content as string
 * @throws {Error} If file does not exist
 */
export async function readResearchFile(
  workspaceDir: string,
  topic: string,
): Promise<string> {
  const filePath = getResearchFilePath(workspaceDir, topic);
  return fs.readFile(filePath, 'utf-8');
}

/**
 * Check if a research workspace exists for a given topic.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @returns true if the research directory exists
 */
export async function researchWorkspaceExists(
  workspaceDir: string,
  topic: string,
): Promise<boolean> {
  const researchDir = getResearchDir(workspaceDir, topic);
  try {
    const stat = await fs.stat(researchDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Update a specific section in the RESEARCH.md file.
 *
 * If the section heading doesn't exist, it is appended.
 * If the section already exists, its content is replaced.
 *
 * Section headings are matched case-insensitively (## heading).
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @param heading - Section heading (without # prefix)
 * @param content - New section content
 * @returns The complete updated file content
 */
export async function updateResearchFileSection(
  workspaceDir: string,
  topic: string,
  heading: string,
  content: string,
): Promise<string> {
  const filePath = getResearchFilePath(workspaceDir, topic);
  const existing = await fs.readFile(filePath, 'utf-8');
  const updated = replaceSection(existing, heading, content);
  await fs.writeFile(filePath, updated, 'utf-8');

  logger.debug(
    { topic, heading, contentLength: content.length },
    'Research file section updated',
  );

  return updated;
}

/**
 * Append content to a specific section in the RESEARCH.md file.
 *
 * Unlike `updateResearchFileSection`, this appends new content
 * to the existing section content rather than replacing it.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @param topic - Research topic
 * @param heading - Section heading (without # prefix)
 * @param content - Content to append
 * @returns The complete updated file content
 */
export async function appendToResearchFileSection(
  workspaceDir: string,
  topic: string,
  heading: string,
  content: string,
): Promise<string> {
  const filePath = getResearchFilePath(workspaceDir, topic);
  const existing = await fs.readFile(filePath, 'utf-8');
  const updated = appendToSection(existing, heading, content);
  await fs.writeFile(filePath, updated, 'utf-8');

  logger.debug(
    { topic, heading, contentLength: content.length },
    'Content appended to research file section',
  );

  return updated;
}

/**
 * Parse all sections from RESEARCH.md content.
 *
 * @param content - Full RESEARCH.md file content
 * @returns Array of parsed sections (excluding the frontmatter/metadata)
 */
export function parseResearchSections(content: string): ResearchSection[] {
  const sections: ResearchSection[] = [];
  const lines = content.split('\n');

  let currentHeading: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    // Match ## headings (not # or ###)
    const headingMatch = line.match(/^## (.+)$/);
    if (headingMatch) {
      // Save previous section
      if (currentHeading !== null) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join('\n').trim(),
        });
      }
      currentHeading = headingMatch[1].trim();
      currentContent = [];
    } else if (currentHeading !== null) {
      currentContent.push(line);
    }
  }

  // Don't forget the last section
  if (currentHeading !== null) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join('\n').trim(),
    });
  }

  return sections;
}

/**
 * List all existing research topics.
 *
 * Scans the `workspace/research/` directory for sub-directories
 * that contain a RESEARCH.md file.
 *
 * @param workspaceDir - Absolute path to the workspace directory
 * @returns Array of topic names (directory names)
 */
export async function listResearchTopics(workspaceDir: string): Promise<string[]> {
  const researchRoot = getResearchRootDir(workspaceDir);

  try {
    const entries = await fs.readdir(researchRoot, { withFileTypes: true });
    const topics: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const researchFile = path.join(researchRoot, entry.name, RESEARCH_FILE_NAME);
        try {
          await fs.access(researchFile);
          topics.push(entry.name);
        } catch {
          // Not a valid research workspace (no RESEARCH.md)
        }
      }
    }

    return topics.sort();
  } catch {
    // Research root directory doesn't exist yet
    return [];
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Sanitize a topic string for use as a directory name.
 *
 * @param topic - Raw topic string
 * @returns Sanitized directory name (max 64 chars, lowercase, hyphens)
 */
function sanitizeTopicName(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')        // Spaces to hyphens
    .replace(/[^a-z0-9\u4e00-\u9fff\-]/g, '') // Keep alphanumeric, CJK, hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-|-$/g, '')       // Trim leading/trailing hyphens
    .slice(0, 64)                // Max 64 characters
    || 'untitled';               // Fallback for empty result
}

/**
 * Generate initial RESEARCH.md content.
 *
 * @param topic - Research topic
 * @param options - Optional objective and context
 * @returns Complete RESEARCH.md file content
 */
function generateResearchFileContent(
  topic: string,
  options?: { objective?: string; context?: string },
): string {
  const timestamp = new Date().toISOString().split('T')[0];
  const lines: string[] = [
    `# Research: ${topic}`,
    '',
    `> Started: ${timestamp}`,
    '',
  ];

  if (options?.objective) {
    lines.push('## Objective',
      '',
      options.objective,
      '');
  }

  if (options?.context) {
    lines.push('## Context',
      '',
      options.context,
      '');
  }

  lines.push(
    '## Findings',
    '',
    '_No findings yet._',
    '',
    '## Questions',
    '',
    '_No questions yet._',
    '',
    '## Sources',
    '',
    '_No sources collected yet._',
    '',
    '## Conclusion',
    '',
    '_Research in progress._',
  );

  return lines.join('\n');
}

/**
 * Replace a section in markdown content.
 *
 * @param content - Full markdown content
 * @param heading - Section heading (without # prefix)
 * @param newContent - New section content
 * @returns Updated markdown content
 */
function replaceSection(content: string, heading: string, newContent: string): string {
  const lines = content.split('\n');
  const normalizedHeading = heading.trim().toLowerCase();
  const result: string[] = [];
  let inTargetSection = false;
  let sectionReplaced = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^## (.+)$/);

    if (headingMatch) {
      const currentHeading = headingMatch[1].trim().toLowerCase();

      if (inTargetSection) {
        // End of target section, stop replacing
        inTargetSection = false;
      }

      if (currentHeading === normalizedHeading) {
        // Found the target section
        inTargetSection = true;
        if (!sectionReplaced) {
          result.push(`## ${heading}`, '', newContent);
          sectionReplaced = true;
        }
        continue;
      }
    }

    if (!inTargetSection) {
      result.push(line);
    }
  }

  // Handle end-of-file section (if target was the last section)
  if (inTargetSection && !sectionReplaced) {
    result.push(`## ${heading}`, '', newContent);
  }

  // If section wasn't found, append it
  if (!sectionReplaced) {
    result.push('', `## ${heading}`, '', newContent);
  }

  return result.join('\n');
}

/**
 * Append content to an existing section in markdown.
 *
 * @param content - Full markdown content
 * @param heading - Section heading (without # prefix)
 * @param appendContent - Content to append
 * @returns Updated markdown content
 */
function appendToSection(content: string, heading: string, appendContent: string): string {
  const lines = content.split('\n');
  const normalizedHeading = heading.trim().toLowerCase();
  const result: string[] = [];
  let inTargetSection = false;
  let sectionFound = false;
  let sectionEndIndex = -1;

  // First pass: find section boundaries
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^## (.+)$/);
    if (headingMatch) {
      const currentHeading = headingMatch[1].trim().toLowerCase();
      if (currentHeading === normalizedHeading) {
        inTargetSection = true;
        sectionFound = true;
        continue;
      } else if (inTargetSection) {
        sectionEndIndex = i;
        inTargetSection = false;
      }
    }
  }

  if (!sectionFound) {
    // Section doesn't exist, append it
    return content + '\n\n' + `## ${heading}` + '\n\n' + appendContent + '\n';
  }

  // Insert before the next section (or at end of file)
  const insertIndex = sectionEndIndex === -1 ? lines.length : sectionEndIndex;
  const insertLines = ['', appendContent];
  lines.splice(insertIndex, 0, ...insertLines);

  return lines.join('\n');
}

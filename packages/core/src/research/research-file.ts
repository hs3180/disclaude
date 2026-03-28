/**
 * ResearchFileManager - Manages RESEARCH.md files for research sessions.
 *
 * This module provides a centralized interface for managing RESEARCH.md state files
 * used during research mode sessions. It handles the full lifecycle:
 *
 * 1. **Initialization**: Create RESEARCH.md with template from topic and goals
 * 2. **Auto-update**: Add findings, questions, resources during research
 * 3. **Archive**: Move completed research to archive directory
 *
 * File location: {workspaceDir}/research/{topic}/RESEARCH.md
 *
 * Design Principles (following TaskFileManager patterns):
 * - Markdown as Data: Structured markdown for human and machine readability
 * - Idempotent operations: Safe to call update functions multiple times
 * - Path safety: Topic names are validated and sanitized
 *
 * @module research/research-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchFileManager');

/**
 * Configuration for ResearchFileManager.
 */
export interface ResearchFileManagerConfig {
  /** Workspace directory (e.g., /workspace) */
  workspaceDir: string;
}

/**
 * Options for initializing a new RESEARCH.md.
 */
export interface ResearchInitOptions {
  /** Research topic name (used as directory name) */
  topic: string;
  /** Brief description of research goals and background */
  description: string;
  /** Initial research goals (checklist items) */
  goals?: string[];
}

/**
 * A single research finding entry.
 */
export interface ResearchFinding {
  /** Finding title/summary */
  title: string;
  /** Source of the finding (URL, document name, etc.) */
  source?: string;
  /** Detailed content of the finding */
  content: string;
}

/**
 * A research question to investigate.
 */
export interface ResearchQuestion {
  /** Question text */
  question: string;
}

/**
 * A research resource link.
 */
export interface ResearchResource {
  /** Resource name/label */
  name: string;
  /** Resource URL or path */
  url: string;
}

/**
 * Parsed RESEARCH.md sections for programmatic access.
 */
export interface ParsedResearch {
  /** Raw markdown content */
  raw: string;
  /** Topic title (from H1 heading) */
  title: string;
  /** Description (from blockquote) */
  description: string;
  /** Research goals (checklist items under ## 研究目标) */
  goals: string[];
  /** Completed goals (checked items) */
  completedGoals: string[];
  /** Pending goals (unchecked items) */
  pendingGoals: string[];
  /** Collected findings (under ## 已收集的信息) */
  findings: ResearchFinding[];
  /** Pending questions (under ## 待调查的问题) */
  questions: string[];
  /** Research conclusion (under ## 研究结论) */
  conclusion: string;
  /** Resource links (under ## 相关资源) */
  resources: ResearchResource[];
}

/** Valid topic name pattern: alphanumeric, hyphens, underscores, dots */
const TOPIC_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate a research topic name for safety.
 *
 * Topic names are used as directory names, so they must be safe for the filesystem.
 * Prevents path traversal attacks (e.g., "../", absolute paths).
 *
 * @param topic - Topic name to validate
 * @returns true if the topic name is valid
 */
export function isValidTopic(topic: string): boolean {
  if (!topic || typeof topic !== 'string') return false;
  if (topic.length === 0 || topic.length > 128) return false;
  if (topic === '.' || topic === '..') return false;
  return TOPIC_PATTERN.test(topic);
}

/**
 * Sanitize a topic name to make it filesystem-safe.
 *
 * Replaces invalid characters with hyphens and ensures the result
 * passes isValidTopic() validation.
 *
 * @param topic - Raw topic name
 * @returns Sanitized topic name
 */
export function sanitizeTopic(topic: string): string {
  return topic
    .trim()
    .toLowerCase()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128) || 'untitled';
}

/**
 * Research file manager for RESEARCH.md lifecycle operations.
 *
 * Manages the creation, reading, updating, and archiving of RESEARCH.md files
 * within the research workspace directory.
 *
 * @example
 * ```typescript
 * const manager = new ResearchFileManager({ workspaceDir: '/workspace' });
 *
 * // Initialize a new research session
 * await manager.initialize({
 *   topic: 'ai-safety',
 *   description: 'Research AI safety best practices',
 *   goals: ['Review alignment research', 'Analyze RLHF methods'],
 * });
 *
 * // Add findings during research
 * await manager.addFinding('ai-safety', {
 *   title: 'Alignment Tax',
 *   source: 'https://arxiv.org/abs/2309.15087',
 *   content: 'Alignment techniques reduce model capability by ~5%',
 * });
 *
 * // Complete and archive
 * await manager.setConclusion('ai-safety', 'Key finding: ...');
 * await manager.archive('ai-safety');
 * ```
 */
export class ResearchFileManager {
  private readonly workspaceDir: string;
  private readonly researchBaseDir: string;

  /**
   * Create a ResearchFileManager.
   *
   * @param config - Configuration with workspaceDir
   */
  constructor(config: ResearchFileManagerConfig) {
    this.workspaceDir = config.workspaceDir;
    this.researchBaseDir = path.join(this.workspaceDir, 'research');
  }

  /**
   * Get the research directory path for a given topic.
   *
   * @param topic - Validated topic name
   * @returns Absolute path to topic's research directory
   */
  getResearchDir(topic: string): string {
    return path.join(this.researchBaseDir, topic);
  }

  /**
   * Get the RESEARCH.md file path for a given topic.
   *
   * @param topic - Validated topic name
   * @returns Absolute path to RESEARCH.md
   */
  getResearchFilePath(topic: string): string {
    return path.join(this.getResearchDir(topic), 'RESEARCH.md');
  }

  /**
   * Get the archive directory path.
   *
   * @returns Absolute path to archive directory
   */
  getArchiveDir(): string {
    return path.join(this.researchBaseDir, '_archived');
  }

  /**
   * Ensure the base research directory exists.
   */
  private async ensureBaseDir(): Promise<void> {
    try {
      await fs.mkdir(this.researchBaseDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create research base directory');
      throw error;
    }
  }

  /**
   * Initialize a new RESEARCH.md file for a research topic.
   *
   * Creates the research directory and populates RESEARCH.md with the standard
   * template structure. Throws if RESEARCH.md already exists for the topic.
   *
   * @param options - Initialization options
   * @throws Error if topic is invalid or RESEARCH.md already exists
   */
  async initialize(options: ResearchInitOptions): Promise<void> {
    const { topic, description, goals = [] } = options;

    if (!isValidTopic(topic)) {
      throw new Error(`Invalid topic name: "${topic}". Must be alphanumeric with hyphens/underscores.`);
    }

    await this.ensureBaseDir();

    const researchDir = this.getResearchDir(topic);
    const filePath = this.getResearchFilePath(topic);

    // Check if already exists
    try {
      await fs.access(filePath);
      throw new Error(`RESEARCH.md already exists for topic "${topic}"`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, proceed
      } else if ((error as Error).message?.includes('already exists')) {
        throw error;
      } else {
        throw error;
      }
    }

    const goalsSection = goals.length > 0
      ? goals.map(g => `- [ ] ${g}`).join('\n')
      : '- [ ] Define research objectives';

    const content = this.buildTemplate(topic, description, goalsSection);

    await fs.mkdir(researchDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
    logger.info({ topic, filePath }, 'RESEARCH.md initialized');
  }

  /**
   * Read the current RESEARCH.md content.
   *
   * @param topic - Validated topic name
   * @returns Raw markdown content of RESEARCH.md
   * @throws Error if file doesn't exist
   */
  async read(topic: string): Promise<string> {
    const filePath = this.getResearchFilePath(topic);
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`RESEARCH.md not found for topic "${topic}"`);
      }
      throw error;
    }
  }

  /**
   * Read and parse RESEARCH.md into structured sections.
   *
   * @param topic - Validated topic name
   * @returns Parsed research data
   */
  async readParsed(topic: string): Promise<ParsedResearch> {
    const raw = await this.read(topic);
    return this.parseContent(raw);
  }

  /**
   * Check if RESEARCH.md exists for a topic.
   *
   * @param topic - Validated topic name
   * @returns True if RESEARCH.md exists
   */
  async exists(topic: string): Promise<boolean> {
    const filePath = this.getResearchFilePath(topic);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all existing research topics.
   *
   * @returns Array of topic names that have RESEARCH.md files
   */
  async listTopics(): Promise<string[]> {
    try {
      await fs.access(this.researchBaseDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.researchBaseDir, { withFileTypes: true });
    const topics: string[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('_')) {
        const researchFile = path.join(this.researchBaseDir, entry.name, 'RESEARCH.md');
        try {
          await fs.access(researchFile);
          topics.push(entry.name);
        } catch {
          // Skip directories without RESEARCH.md
        }
      }
    }

    return topics.sort();
  }

  /**
   * Add a new finding to RESEARCH.md.
   *
   * Appends a new finding entry under the "## 已收集的信息" section.
   * If the section doesn't exist, it will be created.
   *
   * @param topic - Validated topic name
   * @param finding - Finding to add
   */
  async addFinding(topic: string, finding: ResearchFinding): Promise<void> {
    const content = await this.read(topic);
    const findingEntry = this.formatFinding(finding);
    const updated = this.appendToSection(content, '已收集的信息', findingEntry);
    await this.write(topic, updated);
    logger.info({ topic, finding: finding.title }, 'Finding added');
  }

  /**
   * Add a new question to RESEARCH.md.
   *
   * Appends a new question under the "## 待调查的问题" section.
   *
   * @param topic - Validated topic name
   * @param question - Question to add
   */
  async addQuestion(topic: string, question: string): Promise<void> {
    const content = await this.read(topic);
    const entry = `- [ ] ${question}`;
    const updated = this.appendToSection(content, '待调查的问题', entry);
    await this.write(topic, updated);
    logger.info({ topic, question }, 'Question added');
  }

  /**
   * Resolve a question by moving it from "待调查的问题" to "已收集的信息".
   *
   * Marks the question as resolved in the questions section and adds
   * the answer as a new finding.
   *
   * @param topic - Validated topic name
   * @param question - Question text to resolve
   * @param answer - Answer to the question (becomes a finding)
   */
  async resolveQuestion(topic: string, question: string, answer: string): Promise<void> {
    const content = await this.read(topic);
    let updated = content;

    // Check off the question in 待调查的问题
    const questionLine = `- [ ] ${question}`;
    const resolvedLine = `- [x] ${question} (resolved)`;
    if (updated.includes(questionLine)) {
      updated = updated.replace(questionLine, resolvedLine);
    }

    // Add answer as a finding
    const finding: ResearchFinding = {
      title: `Q: ${question}`,
      content: answer,
    };
    const findingEntry = this.formatFinding(finding);
    updated = this.appendToSection(updated, '已收集的信息', findingEntry);

    await this.write(topic, updated);
    logger.info({ topic, question }, 'Question resolved');
  }

  /**
   * Add a resource link to RESEARCH.md.
   *
   * @param topic - Validated topic name
   * @param resource - Resource to add
   */
  async addResource(topic: string, resource: ResearchResource): Promise<void> {
    const content = await this.read(topic);
    const entry = `- [${resource.name}](${resource.url})`;
    const updated = this.appendToSection(content, '相关资源', entry);
    await this.write(topic, updated);
    logger.info({ topic, resource: resource.name }, 'Resource added');
  }

  /**
   * Set the research conclusion.
   *
   * Replaces the content of the "## 研究结论" section with the provided conclusion.
   * If the section doesn't exist, it will be created.
   *
   * @param topic - Validated topic name
   * @param conclusion - Research conclusion text
   */
  async setConclusion(topic: string, conclusion: string): Promise<void> {
    const content = await this.read(topic);
    const updated = this.replaceSection(content, '研究结论', conclusion);
    await this.write(topic, updated);
    logger.info({ topic }, 'Conclusion set');
  }

  /**
   * Mark a research goal as completed.
   *
   * @param topic - Validated topic name
   * @param goal - Goal text to mark complete
   */
  async completeGoal(topic: string, goal: string): Promise<void> {
    const content = await this.read(topic);
    const unchecked = `- [ ] ${goal}`;
    const checked = `- [x] ${goal}`;
    if (content.includes(unchecked)) {
      const updated = content.replace(unchecked, checked);
      await this.write(topic, updated);
      logger.info({ topic, goal }, 'Goal completed');
    }
  }

  /**
   * Add a new research goal.
   *
   * @param topic - Validated topic name
   * @param goal - Goal text to add
   */
  async addGoal(topic: string, goal: string): Promise<void> {
    const content = await this.read(topic);
    const entry = `- [ ] ${goal}`;
    const updated = this.appendToSection(content, '研究目标', entry);
    await this.write(topic, updated);
    logger.info({ topic, goal }, 'Goal added');
  }

  /**
   * Archive a completed research session.
   *
   * Moves the research directory to the archive directory with a timestamp.
   * The directory is renamed to `{topic}_{timestamp}`.
   *
   * @param topic - Validated topic name
   * @returns Path to the archived directory
   * @throws Error if RESEARCH.md doesn't exist or archive fails
   */
  async archive(topic: string): Promise<string> {
    const researchDir = this.getResearchDir(topic);

    // Verify it exists
    try {
      await fs.access(researchDir);
    } catch {
      throw new Error(`Research directory not found for topic "${topic}"`);
    }

    const archiveDir = this.getArchiveDir();
    await fs.mkdir(archiveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const archiveName = `${topic}_${timestamp}`;
    const archivePath = path.join(archiveDir, archiveName);

    await fs.rename(researchDir, archivePath);
    logger.info({ topic, archivePath }, 'Research archived');
    return archivePath;
  }

  /**
   * Delete a research topic directory.
   *
   * @param topic - Validated topic name
   */
  async delete(topic: string): Promise<void> {
    const researchDir = this.getResearchDir(topic);
    try {
      await fs.rm(researchDir, { recursive: true, force: true });
      logger.info({ topic }, 'Research deleted');
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to delete research');
      throw error;
    }
  }

  // =========================================================================
  // Private helpers - Markdown operations
  // =========================================================================

  /**
   * Write content to RESEARCH.md.
   */
  private async write(topic: string, content: string): Promise<void> {
    const filePath = this.getResearchFilePath(topic);
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /**
   * Build the initial RESEARCH.md template.
   */
  private buildTemplate(topic: string, description: string, goalsSection: string): string {
    const displayTopic = topic.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return [
      `# ${displayTopic}`,
      '',
      `> ${description}`,
      '',
      '## 研究目标',
      goalsSection,
      '',
      '## 已收集的信息',
      '',
      '## 待调查的问题',
      '',
      '## 研究结论',
      '',
      '## 相关资源',
      '',
    ].join('\n');
  }

  /**
   * Format a finding as a markdown subsection.
   */
  private formatFinding(finding: ResearchFinding): string {
    const lines = [`### ${finding.title}`];
    if (finding.source) {
      lines.push(`- 来源：${finding.source}`);
    }
    lines.push(`- 关键内容：${finding.content}`);
    return lines.join('\n');
  }

  /**
   * Append content to a specific section in the markdown.
   *
   * Finds the section heading and appends the new content after the section header.
   * If the section doesn't exist, creates it before the next section or at the end.
   *
   * @param content - Full markdown content
   * @param sectionName - Section heading text (without ## prefix)
   * @param entry - Content to append
   * @returns Updated markdown content
   */
  private appendToSection(content: string, sectionName: string, entry: string): string {
    const sectionHeading = `## ${sectionName}`;
    const lines = content.split('\n');
    let sectionIndex = -1;

    // Find the section heading
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === sectionHeading) {
        sectionIndex = i;
        break;
      }
    }

    if (sectionIndex === -1) {
      // Section doesn't exist - insert it before the next ## heading or at the end
      return this.insertSection(content, sectionName, entry);
    }

    // Find the end of this section (next ## heading or end of file)
    // Skip the blank line after heading, then find where content starts
    let insertIndex = sectionIndex + 1;
    // Skip blank lines after heading
    while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
      insertIndex++;
    }

    // If the section is empty (next line is another section or EOF), just add the entry
    if (insertIndex >= lines.length || lines[insertIndex].trimStart().startsWith('## ')) {
      lines.splice(insertIndex, 0, entry);
    } else {
      // Section has content - append after the last non-empty line in the section
      let lastContentIndex = insertIndex;
      for (let i = insertIndex; i < lines.length; i++) {
        if (lines[i].trimStart().startsWith('## ')) {
          break;
        }
        if (lines[i].trim() !== '') {
          lastContentIndex = i;
        }
      }
      lines.splice(lastContentIndex + 1, 0, entry);
    }

    return lines.join('\n');
  }

  /**
   * Replace the content of a section.
   *
   * @param content - Full markdown content
   * @param sectionName - Section heading text
   * @param newContent - New content for the section
   * @returns Updated markdown content
   */
  private replaceSection(content: string, sectionName: string, newContent: string): string {
    const sectionHeading = `## ${sectionName}`;
    const lines = content.split('\n');
    let sectionIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === sectionHeading) {
        sectionIndex = i;
        break;
      }
    }

    if (sectionIndex === -1) {
      // Section doesn't exist - insert it
      return this.insertSection(content, sectionName, newContent);
    }

    // Find the next section heading
    let nextSectionIndex = lines.length;
    for (let i = sectionIndex + 1; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('## ')) {
        nextSectionIndex = i;
        break;
      }
    }

    // Replace section content (keep heading, replace everything after until next section)
    const before = lines.slice(0, sectionIndex + 1);
    const after = lines.slice(nextSectionIndex);

    return [...before, '', newContent, '', ...after].join('\n');
  }

  /**
   * Insert a new section into the markdown content.
   *
   * Inserts before the next highest-level section or at the end.
   *
   * @param content - Full markdown content
   * @param sectionName - Section heading text
   * @param initialContent - Initial content for the section
   * @returns Updated markdown content
   */
  private insertSection(content: string, sectionName: string, initialContent: string): string {
    const sectionHeading = `## ${sectionName}`;
    const lines = content.split('\n');

    // Find the right insertion point (before the next ## section, after the last one)
    let insertIndex = lines.length;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('## ')) {
        // Check if this is alphabetically after our section
        if (lines[i].trim() > sectionHeading) {
          insertIndex = i;
          break;
        }
      }
    }

    lines.splice(insertIndex, 0, '', sectionHeading, '', initialContent);
    return lines.join('\n');
  }

  /**
   * Parse RESEARCH.md content into structured data.
   *
   * @param raw - Raw markdown content
   * @returns Parsed research data
   */
  private parseContent(raw: string): ParsedResearch {
    const lines = raw.split('\n');

    const title = lines.find(l => l.startsWith('# '))?.replace('# ', '').trim() || '';
    const description = lines.find(l => l.startsWith('> '))?.replace('> ', '').trim() || '';

    const goals: string[] = [];
    const completedGoals: string[] = [];
    const pendingGoals: string[] = [];
    const findings: ResearchFinding[] = [];
    const questions: string[] = [];
    let conclusion = '';
    const resources: ResearchResource[] = [];

    let currentSection = '';
    let currentFinding: Partial<ResearchFinding> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Track section changes
      if (line.trimStart().startsWith('## ')) {
        // Save current finding if any
        if (currentFinding && currentFinding.title) {
          findings.push(currentFinding as ResearchFinding);
          currentFinding = null;
        }

        currentSection = line.trim();
        continue;
      }

      // Parse goals
      if (currentSection === '## 研究目标') {
        const checkedMatch = line.match(/^- \[x\] (.+)$/);
        const uncheckedMatch = line.match(/^- \[ \] (.+)$/);
        if (checkedMatch) {
          const goal = checkedMatch[1].trim();
          goals.push(goal);
          completedGoals.push(goal);
        } else if (uncheckedMatch) {
          const goal = uncheckedMatch[1].trim();
          goals.push(goal);
          pendingGoals.push(goal);
        }
      }

      // Parse findings
      if (currentSection === '## 已收集的信息') {
        if (line.trimStart().startsWith('### ')) {
          // Save previous finding
          if (currentFinding && currentFinding.title) {
            findings.push(currentFinding as ResearchFinding);
          }
          currentFinding = { title: line.replace(/^#+\s*/, '').trim() };
        } else if (currentFinding) {
          const sourceMatch = line.match(/^- 来源[：:]\s*(.+)$/);
          const contentMatch = line.match(/^- 关键内容[：:]\s*(.+)$/);
          if (sourceMatch) {
            currentFinding.source = sourceMatch[1].trim();
          } else if (contentMatch) {
            currentFinding.content = contentMatch[1].trim();
          }
        }
      }

      // Parse questions
      if (currentSection === '## 待调查的问题') {
        const uncheckedMatch = line.match(/^- \[ \] (.+?)(?:\s*\(resolved\))?$/);
        if (uncheckedMatch) {
          questions.push(uncheckedMatch[1].trim());
        }
      }

      // Parse conclusion
      if (currentSection === '## 研究结论') {
        if (line.trim() !== '') {
          conclusion += (conclusion ? '\n' : '') + line;
        }
      }

      // Parse resources
      if (currentSection === '## 相关资源') {
        const linkMatch = line.match(/^- \[(.+?)\]\((.+?)\)/);
        if (linkMatch) {
          resources.push({ name: linkMatch[1].trim(), url: linkMatch[2].trim() });
        }
      }
    }

    // Save last finding if any
    if (currentFinding && currentFinding.title) {
      findings.push(currentFinding as ResearchFinding);
    }

    return {
      raw,
      title,
      description,
      goals,
      completedGoals,
      pendingGoals,
      findings,
      questions,
      conclusion,
      resources,
    };
  }
}

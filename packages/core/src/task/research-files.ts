/**
 * ResearchFileManager - Research state file management system.
 *
 * This module provides a centralized interface for managing RESEARCH.md files
 * used during research mode sessions. It implements the research state lifecycle:
 *
 * research/{topic}/
 *   ├── RESEARCH.md          (auto-maintained research state)
 *   ├── OUTLINE.md           (optional: research outline)
 *   ├── PROGRESS.md          (optional: progress tracking)
 *   └── REPORT.md            (optional: final report)
 *
 * RESEARCH.md Structure:
 *   # Research Topic
 *   ## 研究目标
 *   ## 已收集的信息
 *   ## 待调查的问题
 *   ## 研究结论
 *   ## 相关资源
 *
 * Design Principles:
 * - Markdown as Data: Use markdown files to persist research state
 * - Auto-Maintained: Agent updates state after each research interaction
 * - Human-Readable: All state is readable by both humans and machines
 * - Lifecycle-Aware: Created on start, archived on completion
 *
 * @module task/research-files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchFileManager');

/**
 * Research state data model.
 */
export interface ResearchState {
  /** Research topic/title */
  topic: string;
  /** Brief description of research goals and background */
  description: string;
  /** Research objectives (checkbox items) */
  objectives: string[];
  /** Collected findings */
  findings: ResearchFinding[];
  /** Pending questions to investigate */
  pendingQuestions: string[];
  /** Research conclusions (filled on completion) */
  conclusion?: string;
  /** Related resources/links */
  resources: ResearchResource[];
  /** Timestamps */
  createdAt: string;
  updatedAt: string;
}

/**
 * A single research finding.
 */
export interface ResearchFinding {
  /** Finding title */
  title: string;
  /** Source of the finding */
  source: string;
  /** Key content/summary */
  content: string;
  /** Timestamp when discovered */
  discoveredAt: string;
}

/**
 * A research resource link.
 */
export interface ResearchResource {
  /** Resource name */
  name: string;
  /** URL or path */
  url: string;
}

/**
 * Research file manager configuration.
 */
export interface ResearchFileManagerConfig {
  /** Workspace directory for research files */
  workspaceDir: string;
  /** Optional subdirectory prefix (default: 'research') */
  subdirectory?: string;
}

/**
 * Default RESEARCH.md template.
 */
function generateResearchTemplate(state: ResearchState): string {
  const objectivesList = state.objectives
    .map((obj) => `- [ ] ${obj}`)
    .join('\n');

  const findingsSection = state.findings.length > 0
    ? state.findings.map(formatFinding).join('\n\n')
    : '（暂无发现）';

  const questionsList = state.pendingQuestions.length > 0
    ? state.pendingQuestions.map((q) => `- [ ] ${q}`).join('\n')
    : '（暂无待调查问题）';

  const resourcesList = state.resources.length > 0
    ? state.resources.map((r) => `- [${r.name}](${r.url})`).join('\n')
    : '（暂无相关资源）';

  const conclusionSection = state.conclusion || '（研究完成后填写）';

  return `# ${state.topic}

> ${state.description}

## 研究目标

${objectivesList}

## 已收集的信息

${findingsSection}

## 待调查的问题

${questionsList}

## 研究结论

${conclusionSection}

## 相关资源

${resourcesList}

---

*创建时间: ${state.createdAt}*
*最后更新: ${state.updatedAt}*
`;
}

/**
 * Format a single finding as markdown.
 */
function formatFinding(finding: ResearchFinding): string {
  return `### ${finding.title}

- **来源**: ${finding.source}
- **关键内容**: ${finding.content}
- **发现时间**: ${finding.discoveredAt}`;
}

/**
 * Parse RESEARCH.md content back into ResearchState.
 * Uses section-based parsing for robustness.
 */
export function parseResearchMd(content: string): ResearchState | null {
  try {
    if (!content || content.trim().length === 0) {
      return null;
    }

    const lines = content.split('\n');
    let topic = '未知主题';
    let description = '';
    const objectives: string[] = [];
    const findings: ResearchFinding[] = [];
    const pendingQuestions: string[] = [];
    let conclusion = '';
    const resources: ResearchResource[] = [];
    let createdAt = '';
    let updatedAt = '';

    let currentSection = '';
    let currentFinding: Partial<ResearchFinding> | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Extract topic from H1
      if (line.startsWith('# ') && !line.startsWith('## ')) {
        topic = line.slice(2).trim();
        currentSection = '';
        continue;
      }

      // Detect section headers (H2)
      if (line.startsWith('## ')) {
        // Save current finding if any
        if (currentFinding) {
          findings.push({
            title: currentFinding.title || '',
            source: currentFinding.source || '',
            content: currentFinding.content || '',
            discoveredAt: currentFinding.discoveredAt || new Date().toISOString(),
          });
          currentFinding = null;
        }

        const header = line.slice(3).trim();
        if (header === '研究目标') {
          currentSection = 'objectives';
        } else if (header === '已收集的信息') {
          currentSection = 'findings';
        } else if (header === '待调查的问题') {
          currentSection = 'questions';
        } else if (header === '研究结论') {
          currentSection = 'conclusion';
        } else if (header === '相关资源') {
          currentSection = 'resources';
        } else {
          currentSection = '';
        }
        continue;
      }

      // Detect finding sub-headers (H3)
      if (line.startsWith('### ') && currentSection === 'findings') {
        if (currentFinding) {
          findings.push({
            title: currentFinding.title || '',
            source: currentFinding.source || '',
            content: currentFinding.content || '',
            discoveredAt: currentFinding.discoveredAt || new Date().toISOString(),
          });
        }
        currentFinding = { title: line.slice(4).trim() };
        continue;
      }

      // Extract description from blockquote
      if (line.startsWith('> ') && currentSection === '') {
        description = line.slice(2).trim();
        continue;
      }

      // Extract timestamps (may be wrapped in markdown italic *)
      if (line.includes('创建时间:')) {
        createdAt = line.split('创建时间:')[1]?.replace(/\*/g, '').trim() || '';
        continue;
      }
      if (line.includes('最后更新:')) {
        updatedAt = line.split('最后更新:')[1]?.replace(/\*/g, '').trim() || '';
        continue;
      }

      // Skip separators and empty lines for section content
      if (line.trim() === '' || line.trim() === '---') {
        continue;
      }

      // Parse section content
      if (currentSection === 'objectives') {
        const match = line.match(/^- \[[ x]\] (.+)$/);
        if (match) {
          objectives.push(match[1]);
        }
      } else if (currentSection === 'findings') {
        if (currentFinding) {
          if (line.includes('**来源**:')) {
            currentFinding.source = line.split('**来源**:')[1]?.trim() || '';
          } else if (line.includes('**关键内容**:')) {
            currentFinding.content = line.split('**关键内容**:')[1]?.trim() || '';
          } else if (line.includes('**发现时间**:')) {
            currentFinding.discoveredAt = line.split('**发现时间**:')[1]?.trim() || '';
          }
        }
        // Skip placeholder text
      } else if (currentSection === 'questions') {
        const match = line.match(/^- \[[ x]\] (.+)$/);
        if (match) {
          pendingQuestions.push(match[1]);
        }
      } else if (currentSection === 'conclusion') {
        if (line.trim() !== '（研究完成后填写）') {
          conclusion += (conclusion ? '\n' : '') + line;
        }
      } else if (currentSection === 'resources') {
        const match = line.match(/^- \[(.+?)\]\((.+?)\)$/);
        if (match) {
          resources.push({ name: match[1], url: match[2] });
        }
      }
    }

    // Save last finding if any
    if (currentFinding) {
      findings.push({
        title: currentFinding.title || '',
        source: currentFinding.source || '',
        content: currentFinding.content || '',
        discoveredAt: currentFinding.discoveredAt || new Date().toISOString(),
      });
    }

    return {
      topic,
      description,
      objectives,
      findings,
      pendingQuestions,
      conclusion: conclusion.trim() || undefined,
      resources,
      createdAt,
      updatedAt,
    };
  } catch (error) {
    logger.error({ err: error }, 'Failed to parse RESEARCH.md');
    return null;
  }
}

/**
 * Research file manager for RESEARCH.md lifecycle operations.
 *
 * Provides methods for:
 * - Phase 1: Initializing research directory and RESEARCH.md template
 * - Phase 2: Updating findings, questions, and other sections
 * - Phase 3: Finalizing and archiving research
 */
export class ResearchFileManager {
  private readonly workspaceDir: string;
  private readonly researchBaseDir: string;

  /**
   * Create a ResearchFileManager.
   *
   * @param config - Configuration with workspaceDir and optional subdirectory
   */
  constructor(config: ResearchFileManagerConfig) {
    this.workspaceDir = config.workspaceDir;
    this.researchBaseDir = config.subdirectory
      ? path.join(this.workspaceDir, config.subdirectory)
      : path.join(this.workspaceDir, 'research');
  }

  /**
   * Ensure the base research directory exists.
   */
  private async ensureBaseDir(): Promise<void> {
    try {
      await fs.mkdir(this.researchBaseDir, { recursive: true });
    } catch (error) {
      logger.error({ err: error }, 'Failed to create base research directory');
      throw error;
    }
  }

  /**
   * Get the research directory path for a given topic.
   *
   * @param topic - Research topic identifier
   * @returns Absolute path to research directory
   */
  getResearchDir(topic: string): string {
    // Sanitize topic to make it a valid directory name
    const sanitized = topic
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 100);
    return path.join(this.researchBaseDir, sanitized);
  }

  /**
   * Get RESEARCH.md file path for a given topic.
   *
   * @param topic - Research topic identifier
   * @returns Absolute path to RESEARCH.md
   */
  getResearchFilePath(topic: string): string {
    return path.join(this.getResearchDir(topic), 'RESEARCH.md');
  }

  // ─── Phase 1: File Initialization ────────────────────────────────

  /**
   * Initialize a new research session.
   *
   * Creates the research directory and RESEARCH.md template file.
   * If a RESEARCH.md already exists, it will NOT be overwritten.
   *
   * @param topic - Research topic/title
   * @param description - Brief description of research goals
   * @param objectives - Initial research objectives
   * @returns The created ResearchState
   * @throws {Error} If directory or file creation fails
   */
  async initializeResearch(
    topic: string,
    description: string,
    objectives: string[] = [],
  ): Promise<ResearchState> {
    await this.ensureBaseDir();

    const researchDir = this.getResearchDir(topic);
    const researchFilePath = this.getResearchFilePath(topic);

    // Check if RESEARCH.md already exists
    const existing = await this.readResearchState(topic);
    if (existing) {
      logger.info({ topic }, 'RESEARCH.md already exists, skipping initialization');
      return existing;
    }

    const now = new Date().toISOString();
    const state: ResearchState = {
      topic,
      description,
      objectives,
      findings: [],
      pendingQuestions: [],
      resources: [],
      createdAt: now,
      updatedAt: now,
    };

    try {
      await fs.mkdir(researchDir, { recursive: true });
      await fs.writeFile(researchFilePath, generateResearchTemplate(state), 'utf-8');
      logger.info({ topic, researchDir }, 'Research session initialized');
      return state;
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to initialize research session');
      throw error;
    }
  }

  // ─── Phase 2: Auto-Update Operations ─────────────────────────────

  /**
   * Read current research state from RESEARCH.md.
   *
   * @param topic - Research topic identifier
   * @returns Current ResearchState or null if file doesn't exist
   */
  async readResearchState(topic: string): Promise<ResearchState | null> {
    const researchFilePath = this.getResearchFilePath(topic);

    try {
      const content = await fs.readFile(researchFilePath, 'utf-8');
      return parseResearchMd(content);
    } catch (error) {
      // File doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Add a new finding to the research state.
   *
   * @param topic - Research topic identifier
   * @param finding - The finding to add
   * @returns Updated ResearchState
   * @throws {Error} If research file doesn't exist or write fails
   */
  async addFinding(topic: string, finding: Omit<ResearchFinding, 'discoveredAt'>): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);

    state.findings.push({
      ...finding,
      discoveredAt: new Date().toISOString(),
    });

    await this.writeState(topic, state);
    logger.info({ topic, findingTitle: finding.title }, 'Finding added');
    return state;
  }

  /**
   * Add multiple findings at once.
   *
   * @param topic - Research topic identifier
   * @param newFindings - Array of findings to add
   * @returns Updated ResearchState
   */
  async addFindings(topic: string, newFindings: Omit<ResearchFinding, 'discoveredAt'>[]): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);

    const now = new Date().toISOString();
    for (const finding of newFindings) {
      state.findings.push({ ...finding, discoveredAt: now });
    }

    await this.writeState(topic, state);
    logger.info({ topic, count: newFindings.length }, 'Findings added');
    return state;
  }

  /**
   * Add a pending question to investigate.
   *
   * @param topic - Research topic identifier
   * @param question - The question to add
   * @returns Updated ResearchState
   */
  async addPendingQuestion(topic: string, question: string): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);

    if (!state.pendingQuestions.includes(question)) {
      state.pendingQuestions.push(question);
    }

    await this.writeState(topic, state);
    logger.info({ topic, question }, 'Pending question added');
    return state;
  }

  /**
   * Resolve a pending question by moving it to a finding.
   *
   * Removes the question from "待调查的问题" and creates a new finding
   * in "已收集的信息".
   *
   * @param topic - Research topic identifier
   * @param question - The question to resolve (exact match)
   * @param finding - The finding that answers the question
   * @returns Updated ResearchState
   */
  async resolveQuestion(
    topic: string,
    question: string,
    finding: Omit<ResearchFinding, 'discoveredAt'>,
  ): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);

    // Remove the question from pending list
    const questionIndex = state.pendingQuestions.indexOf(question);
    if (questionIndex !== -1) {
      state.pendingQuestions.splice(questionIndex, 1);
    }

    // Add as a finding
    state.findings.push({
      ...finding,
      discoveredAt: new Date().toISOString(),
    });

    await this.writeState(topic, state);
    logger.info({ topic, question }, 'Question resolved and moved to findings');
    return state;
  }

  /**
   * Add a resource link.
   *
   * @param topic - Research topic identifier
   * @param resource - The resource to add
   * @returns Updated ResearchState
   */
  async addResource(topic: string, resource: ResearchResource): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);

    // Avoid duplicates by URL
    const exists = state.resources.some((r) => r.url === resource.url);
    if (!exists) {
      state.resources.push(resource);
    }

    await this.writeState(topic, state);
    logger.info({ topic, resourceName: resource.name }, 'Resource added');
    return state;
  }

  /**
   * Mark an objective as completed.
   *
   * @param topic - Research topic identifier
   * @param objective - The objective text to mark complete (exact match)
   * @returns Updated ResearchState, or null if objective not found
   */
  async completeObjective(topic: string, objective: string): Promise<ResearchState | null> {
    const state = await this.readResearchStateOrThrow(topic);

    // Objectives are stored as plain text; completion tracking is
    // done via the markdown rendering (checkbox state).
    // Since we store objectives as strings and render as checkboxes,
    // we don't need to modify the array — the rendering handles it.
    // Instead, we just update the timestamp to reflect the change.
    const index = state.objectives.indexOf(objective);
    if (index === -1) {
      logger.warn({ topic, objective }, 'Objective not found');
      return null;
    }

    // Mark as completed by prefixing with [x] convention
    // Store completed objectives with a prefix
    state.objectives[index] = `[completed] ${objective}`;
    await this.writeState(topic, state);
    logger.info({ topic, objective }, 'Objective completed');
    return state;
  }

  /**
   * Get the raw markdown content of RESEARCH.md.
   *
   * Useful for injecting into agent context or displaying to users.
   *
   * @param topic - Research topic identifier
   * @returns Raw markdown content or null if file doesn't exist
   */
  async readRawMarkdown(topic: string): Promise<string | null> {
    const researchFilePath = this.getResearchFilePath(topic);

    try {
      return await fs.readFile(researchFilePath, 'utf-8');
    } catch {
      return null;
    }
  }

  // ─── Phase 3: Conclusion & Archive ───────────────────────────────

  /**
   * Finalize research by writing the conclusion.
   *
   * @param topic - Research topic identifier
   * @param conclusion - Research conclusion summary
   * @returns Updated ResearchState
   */
  async finalizeResearch(topic: string, conclusion: string): Promise<ResearchState> {
    const state = await this.readResearchStateOrThrow(topic);
    state.conclusion = conclusion;
    await this.writeState(topic, state);
    logger.info({ topic }, 'Research finalized with conclusion');
    return state;
  }

  /**
   * Archive a completed research session.
   *
   * Moves the research directory to an archive subdirectory with a
   * timestamp suffix.
   *
   * @param topic - Research topic identifier
   * @param archiveDir - Optional custom archive directory (default: 'research/_archived')
   * @returns Path to the archived directory
   */
  async archiveResearch(topic: string, archiveDir?: string): Promise<string> {
    const sourceDir = this.getResearchDir(topic);
    const targetBase = archiveDir
      ? path.join(this.workspaceDir, archiveDir)
      : path.join(this.researchBaseDir, '_archived');

    // Create archive directory
    await fs.mkdir(targetBase, { recursive: true });

    // Generate archive name with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sanitizedTopic = topic
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_')
      .slice(0, 50);
    const archiveName = `${sanitizedTopic}_${timestamp}`;
    const targetDir = path.join(targetBase, archiveName);

    try {
      await fs.rename(sourceDir, targetDir);
      logger.info({ topic, archivePath: targetDir }, 'Research archived');
      return targetDir;
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to archive research');
      throw error;
    }
  }

  // ─── Utility Methods ─────────────────────────────────────────────

  /**
   * Check if a research session exists.
   *
   * @param topic - Research topic identifier
   * @returns True if RESEARCH.md exists
   */
  async researchExists(topic: string): Promise<boolean> {
    const researchFilePath = this.getResearchFilePath(topic);

    try {
      await fs.access(researchFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all research topics.
   *
   * @returns Array of topic names that have RESEARCH.md files
   */
  async listResearchTopics(): Promise<string[]> {
    await this.ensureBaseDir();

    try {
      const entries = await fs.readdir(this.researchBaseDir, { withFileTypes: true });
      const topics: string[] = [];

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('_')) {
          const researchFile = path.join(this.researchBaseDir, entry.name, 'RESEARCH.md');
          try {
            await fs.access(researchFile);
            topics.push(entry.name);
          } catch {
            // No RESEARCH.md in this directory
          }
        }
      }

      return topics;
    } catch {
      return [];
    }
  }

  /**
   * Get research statistics.
   *
   * @param topic - Research topic identifier
   * @returns Research statistics
   */
  async getResearchStats(topic: string): Promise<{
    totalFindings: number;
    pendingQuestions: number;
    totalObjectives: number;
    hasConclusion: boolean;
    totalResources: number;
  } | null> {
    const state = await this.readResearchState(topic);
    if (!state) {
      return null;
    }

    return {
      totalFindings: state.findings.length,
      pendingQuestions: state.pendingQuestions.length,
      totalObjectives: state.objectives.length,
      hasConclusion: !!state.conclusion,
      totalResources: state.resources.length,
    };
  }

  /**
   * Delete a research session (use with caution).
   *
   * @param topic - Research topic identifier
   */
  async deleteResearch(topic: string): Promise<void> {
    const researchDir = this.getResearchDir(topic);

    try {
      await fs.rm(researchDir, { recursive: true, force: true });
      logger.info({ topic }, 'Research session deleted');
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to delete research session');
      throw error;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  /**
   * Read research state or throw if not found.
   */
  private async readResearchStateOrThrow(topic: string): Promise<ResearchState> {
    const state = await this.readResearchState(topic);
    if (!state) {
      throw new Error(`Research session not found for topic: "${topic}". Call initializeResearch() first.`);
    }
    return state;
  }

  /**
   * Write research state to RESEARCH.md.
   */
  private async writeState(topic: string, state: ResearchState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const content = generateResearchTemplate(state);
    const researchFilePath = this.getResearchFilePath(topic);

    try {
      await fs.writeFile(researchFilePath, content, 'utf-8');
    } catch (error) {
      logger.error({ err: error, topic }, 'Failed to write RESEARCH.md');
      throw error;
    }
  }
}

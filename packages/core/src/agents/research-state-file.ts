/**
 * Research State File Manager
 *
 * Issue #1710: Manages RESEARCH.md files that track research session state.
 * Similar to CLAUDE.md but scoped to a single research session.
 *
 * Lifecycle:
 * 1. init() - Create research directory and RESEARCH.md template
 * 2. addFinding() / addQuestion() / resolveQuestion() - Update sections
 * 3. finalizeConclusion() - Write conclusion and mark research complete
 *
 * Designed as a standalone utility that can integrate with ModeManager
 * (Issue #1709) when Research Mode is available.
 *
 * @module agents/research-state-file
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ResearchStateFile');

/**
 * Research topic definition for initializing a RESEARCH.md file.
 */
export interface ResearchTopic {
  /** Research topic title */
  topic: string;
  /** Research goals (checklist items) */
  goals: string[];
  /** Optional background description */
  background?: string;
}

/**
 * A research finding to add to the "已收集的信息" section.
 */
export interface ResearchFinding {
  /** Finding title/heading */
  title: string;
  /** Source of the finding (URL, document name, etc.) */
  source?: string;
  /** Key content/summary of the finding */
  content: string;
}

/**
 * Options for initializing a ResearchStateFile.
 */
export interface ResearchStateFileOptions {
  /** Path to the research working directory (RESEARCH.md is created here) */
  researchDir: string;
  /** Research topic definition */
  topic: ResearchTopic;
}

/**
 * Manages a RESEARCH.md state file for a research session.
 *
 * The file follows a structured markdown format with sections for:
 * - Research topic and goals
 * - Collected findings and information
 * - Pending questions to investigate
 * - Research conclusions
 * - Related resources
 *
 * @example
 * ```typescript
 * const rsf = await ResearchStateFile.init({
 *   researchDir: '/workspace/research/ai-safety',
 *   topic: {
 *     topic: 'AI Safety Research',
 *     goals: ['Survey alignment techniques', 'Analyze current benchmarks'],
 *     background: 'Investigating state-of-the-art AI safety approaches',
 *   },
 * });
 *
 * await rsf.addFinding({
 *   title: 'RLHF Effectiveness',
 *   source: 'https://arxiv.org/abs/2209.07858',
 *   content: 'RLHF reduces harmful outputs by 50% in evaluated scenarios',
 * });
 *
 * await rsf.addQuestion('What are the limitations of constitutional AI?');
 * await rsf.resolveQuestion('What are the limitations of constitutional AI?');
 * await rsf.finalizeConclusion('RLHF and CAI together provide robust safety alignment...');
 * ```
 */
export class ResearchStateFile {
  private readonly filePath: string;
  private readonly researchDir: string;
  private readonly topic: ResearchTopic;

  private constructor(options: ResearchStateFileOptions) {
    this.researchDir = options.researchDir;
    this.filePath = path.join(options.researchDir, 'RESEARCH.md');
    this.topic = options.topic;
  }

  /**
   * Initialize a new RESEARCH.md file.
   *
   * Creates the research directory if it doesn't exist, then writes
   * the initial template with the provided topic and goals.
   *
   * @param options - Initialization options
   * @returns A new ResearchStateFile instance
   * @throws If the directory cannot be created or file cannot be written
   */
  static async init(options: ResearchStateFileOptions): Promise<ResearchStateFile> {
    const instance = new ResearchStateFile(options);

    await fs.mkdir(instance.researchDir, { recursive: true });
    const template = instance.generateTemplate();
    await fs.writeFile(instance.filePath, template, 'utf-8');

    logger.info({ path: instance.filePath, topic: options.topic.topic }, 'Initialized RESEARCH.md');
    return instance;
  }

  /**
   * Load an existing RESEARCH.md file.
   *
   * @param researchDir - Path to the research directory containing RESEARCH.md
   * @returns A ResearchStateFile instance for the existing file
   * @throws If the file does not exist
   */
  static async load(researchDir: string): Promise<ResearchStateFile> {
    const filePath = path.join(researchDir, 'RESEARCH.md');
    try {
      await fs.access(filePath);
    } catch {
      throw new Error(`RESEARCH.md not found at: ${filePath}`);
    }

    const instance = new ResearchStateFile({
      researchDir,
      topic: { topic: '', goals: [] },
    });
    return instance;
  }

  /**
   * Generate the initial RESEARCH.md template.
   */
  private generateTemplate(): string {
    const backgroundLine = this.topic.background
      ? `\n> ${this.topic.background}`
      : '';

    const goalsList = this.topic.goals.length > 0
      ? this.topic.goals.map(g => `- [ ] ${g}`).join('\n')
      : '- [ ] (待定义)';

    return [
      `# ${this.topic.topic}`,
      backgroundLine,
      '',
      '## 研究目标',
      goalsList,
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
   * Insert content at the end of a section (before the next `## ` heading).
   *
   * Finds the next `## ` heading after the section marker and inserts
   * the new content right before it, preserving correct ordering.
   */
  private insertAtEndOfSection(content: string, sectionMarker: string, newContent: string): string {
    const markerIdx = content.indexOf(sectionMarker);
    if (markerIdx === -1) {
      return content;
    }

    // Find the next "## " heading after the section marker
    const searchStart = markerIdx + sectionMarker.length;
    const nextHeadingIdx = content.indexOf('\n## ', searchStart);

    if (nextHeadingIdx === -1) {
      // No next heading — append at end
      return content + newContent + '\n';
    }

    // Insert before the next heading
    const before = content.slice(0, nextHeadingIdx);
    const after = content.slice(nextHeadingIdx);
    return before + newContent + '\n' + after;
  }

  /**
   * Check if the RESEARCH.md file exists.
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read the current content of RESEARCH.md.
   *
   * @returns The file content as a string
   * @throws If the file cannot be read
   */
  async read(): Promise<string> {
    return fs.readFile(this.filePath, 'utf-8');
  }

  /**
   * Get the absolute path to the RESEARCH.md file.
   */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Get the research directory path.
   */
  getResearchDir(): string {
    return this.researchDir;
  }

  /**
   * Add a finding to the "已收集的信息" section.
   *
   * Findings are appended as subsections with source and content.
   *
   * @param finding - The finding to add
   */
  async addFinding(finding: ResearchFinding): Promise<void> {
    const content = await this.read();
    const findingSection = [
      `### ${finding.title}`,
      `- 来源：${finding.source || '未知'}`,
      `- 关键内容：${finding.content}`,
    ].join('\n');

    const updated = this.insertAtEndOfSection(
      content,
      '## 已收集的信息',
      findingSection
    );

    await fs.writeFile(this.filePath, updated, 'utf-8');
    logger.debug({ title: finding.title }, 'Added finding to RESEARCH.md');
  }

  /**
   * Add a question to the "待调查的问题" section.
   *
   * @param question - The question to add
   */
  async addQuestion(question: string): Promise<void> {
    const content = await this.read();
    const updated = this.insertAtEndOfSection(
      content,
      '## 待调查的问题',
      `- [ ] ${question}`
    );

    await fs.writeFile(this.filePath, updated, 'utf-8');
    logger.debug({ question }, 'Added question to RESEARCH.md');
  }

  /**
   * Mark a question as resolved in the "待调查的问题" section.
   *
   * Changes `- [ ] question` to `- [x] question`.
   *
   * @param question - The exact question text to mark as resolved
   * @returns true if the question was found and resolved, false otherwise
   */
  async resolveQuestion(question: string): Promise<boolean> {
    const content = await this.read();
    const unresolved = `- [ ] ${question}`;
    const resolved = `- [x] ${question}`;

    if (!content.includes(unresolved)) {
      logger.warn({ question }, 'Question not found in RESEARCH.md');
      return false;
    }

    const updated = content.replace(unresolved, resolved);
    await fs.writeFile(this.filePath, updated, 'utf-8');
    logger.debug({ question }, 'Resolved question in RESEARCH.md');
    return true;
  }

  /**
   * Add a resource link to the "相关资源" section.
   *
   * @param name - Resource name/label
   * @param url - Resource URL or path
   */
  async addResource(name: string, url: string): Promise<void> {
    const content = await this.read();
    const resourceLine = `- [${name}](${url})`;

    const updated = this.insertAtEndOfSection(
      content,
      '## 相关资源',
      resourceLine
    );

    await fs.writeFile(this.filePath, updated, 'utf-8');
    logger.debug({ name, url }, 'Added resource to RESEARCH.md');
  }

  /**
   * Write the final conclusion to the "研究结论" section.
   *
   * This should be called when the research session is complete.
   * Replaces any existing conclusion content.
   *
   * @param conclusion - The conclusion text (can be multi-line markdown)
   */
  async finalizeConclusion(conclusion: string): Promise<void> {
    const content = await this.read();
    const updated = content.replace(
      '## 研究结论\n',
      `## 研究结论\n${conclusion}\n`
    );

    await fs.writeFile(this.filePath, updated, 'utf-8');
    logger.info('Finalized research conclusion in RESEARCH.md');
  }
}

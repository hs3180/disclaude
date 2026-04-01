/**
 * Research State File Manager - Manages RESEARCH.md for tracking research progress.
 *
 * This module provides utilities for creating, reading, and updating RESEARCH.md
 * files within research working directories. RESEARCH.md serves as a living document
 * that tracks research goals, findings, questions, conclusions, and resources.
 *
 * Issue #1710 - RESEARCH.md research state file.
 *
 * Integration with Research Mode (Issue #1709):
 * - When `ResearchModeManager.enterResearch()` is called, it should also call
 *   `ResearchStateFile.initialize()` to create the RESEARCH.md alongside CLAUDE.md.
 * - The agent's SOUL (CLAUDE.md) instructs it to maintain RESEARCH.md after each
 *   research interaction by calling the update methods.
 *
 * @module agents/research-state
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../utils/logger.js';

const logger = createLogger('ResearchState');

// ============================================================================
// Types
// ============================================================================

/**
 * Options for initializing a new RESEARCH.md file.
 */
export interface ResearchStateInitOptions {
  /** Research topic/title */
  topic: string;
  /** Brief description of research goals and background */
  description?: string;
  /** Initial research goals */
  goals?: string[];
  /** Related resources to include */
  resources?: Array<{ name: string; url: string }>;
}

/**
 * A research finding entry.
 */
export interface ResearchFinding {
  /** Finding title/summary */
  title: string;
  /** Source of the finding */
  source?: string;
  /** Detailed content */
  content: string;
  /** Timestamp when the finding was recorded (ISO 8601) */
  recordedAt: string;
}

/**
 * A research question to investigate.
 */
export interface ResearchQuestion {
  /** Question text */
  text: string;
  /** Whether the question has been resolved */
  resolved: boolean;
  /** Resolution notes (when resolved) */
  resolution?: string;
  /** Timestamp when the question was added */
  addedAt: string;
  /** Timestamp when the question was resolved */
  resolvedAt?: string;
}

/**
 * Parsed RESEARCH.md state.
 */
export interface ResearchState {
  /** Research topic/title */
  topic: string;
  /** Description/background */
  description: string;
  /** Research goals with completion status */
  goals: Array<{ text: string; completed: boolean }>;
  /** Collected findings */
  findings: ResearchFinding[];
  /** Questions to investigate */
  questions: ResearchQuestion[];
  /** Research conclusion (when research is complete) */
  conclusion?: string;
  /** Related resources */
  resources: Array<{ name: string; url: string }>;
  /** Whether research has been concluded/archived */
  archived: boolean;
  /** Timestamp of last update (ISO 8601) */
  lastUpdatedAt: string;
}

/**
 * Options for adding a finding.
 */
export interface AddFindingOptions {
  /** Finding title/summary */
  title: string;
  /** Source URL or reference */
  source?: string;
  /** Detailed content of the finding */
  content: string;
}

/**
 * Options for adding a resource.
 */
export interface AddResourceOptions {
  /** Resource name/label */
  name: string;
  /** Resource URL */
  url: string;
}

/**
 * Result of initializing a RESEARCH.md file.
 */
export interface ResearchStateInitResult {
  /** Absolute path to the RESEARCH.md file */
  filePath: string;
  /** Whether the file was newly created (true) or already existed (false) */
  created: boolean;
}

// ============================================================================
// Markdown Generation
// ============================================================================

/**
 * Generate the complete RESEARCH.md markdown from a ResearchState.
 *
 * This is the single source of truth for file format.
 * All updates work by: parse → mutate state → regenerate.
 */
function generateMarkdown(state: ResearchState): string {
  const now = new Date().toISOString();
  const lines: string[] = [];

  // Header
  lines.push(`# ${state.topic}`);
  lines.push('');
  lines.push(`> ${state.description || 'Research in progress...'}`);
  lines.push('');
  lines.push(`<!-- LAST_UPDATED:${now} -->`);
  lines.push('');

  // Research Goals
  lines.push('## Research Goals');
  lines.push('');
  lines.push(generateGoalsMarkdown(state.goals));
  lines.push('');

  // Collected Findings
  lines.push('## Collected Findings');
  lines.push('');
  lines.push(generateFindingsMarkdown(state.findings));
  lines.push('');

  // Questions to Investigate
  lines.push('## Questions to Investigate');
  lines.push('');
  lines.push(generateQuestionsMarkdown(state.questions));
  lines.push('');

  // Research Conclusion
  lines.push('## Research Conclusion');
  lines.push('');
  lines.push(state.conclusion || '_Research not yet concluded_');
  lines.push('');

  // Related Resources
  lines.push('## Related Resources');
  lines.push('');
  lines.push(generateResourcesMarkdown(state.resources));
  lines.push('');

  return lines.join('\n');
}

/**
 * Generate markdown for goals list.
 */
function generateGoalsMarkdown(goals: Array<{ text: string; completed: boolean }>): string {
  if (goals.length === 0) return '- [ ] Define research goals';
  return goals.map(g => `- [${g.completed ? 'x' : ' '}] ${g.text}`).join('\n');
}

/**
 * Generate markdown for findings.
 */
function generateFindingsMarkdown(findings: ResearchFinding[]): string {
  if (findings.length === 0) return '_No findings yet_';

  return findings.map(f => {
    const parts: string[] = [`### ${f.title}`];
    if (f.source) {
      parts.push(`- **Source**: ${f.source}`);
    }
    parts.push(`- **Recorded**: ${f.recordedAt}`);
    if (f.content) {
      parts.push('');
      parts.push(f.content);
    }
    return parts.join('\n');
  }).join('\n\n');
}

/**
 * Generate markdown for questions.
 */
function generateQuestionsMarkdown(questions: ResearchQuestion[]): string {
  if (questions.length === 0) return '_No questions yet_';

  return questions.map(q => {
    if (q.resolved) {
      return `- [x] ${q.text} — ${q.resolution || 'Resolved'}`;
    }
    return `- [ ] ${q.text}`;
  }).join('\n');
}

/**
 * Generate markdown for resources.
 */
function generateResourcesMarkdown(resources: Array<{ name: string; url: string }>): string {
  if (resources.length === 0) return '- _No resources yet_';
  return resources.map(r => `- [${r.name}](${r.url})`).join('\n');
}

// ============================================================================
// Parsing Utilities
// ============================================================================

/**
 * Parse a complete RESEARCH.md markdown into a ResearchState.
 */
function parseMarkdown(markdown: string): ResearchState {
  const topic = extractTopic(markdown);
  const description = extractDescription(markdown);
  const lastUpdatedAt = extractLastUpdated(markdown);

  // Split into sections by H2 headings
  const sections = splitIntoSections(markdown);

  const goals = parseGoalsSection(sections['Research Goals'] || '');
  const findings = parseFindingsSection(sections['Collected Findings'] || '');
  const questions = parseQuestionsSection(sections['Questions to Investigate'] || '');
  const conclusion = extractConclusionText(sections['Research Conclusion'] || '');
  const resources = parseResourcesSection(sections['Related Resources'] || '');

  const archived = !!conclusion && conclusion !== '_Research not yet concluded_';

  return {
    topic,
    description,
    goals,
    findings,
    questions,
    conclusion: archived ? conclusion : undefined,
    resources,
    archived,
    lastUpdatedAt,
  };
}

/**
 * Split markdown into sections by H2 headings.
 * Returns a map of section name → content.
 */
function splitIntoSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const h2Regex = /^## (.+)$/gm;
  let lastMatch: RegExpExecArray | null = null;
  let currentMatch: RegExpExecArray | null = null;

  while ((currentMatch = h2Regex.exec(markdown)) !== null) {
    if (lastMatch) {
      const name = lastMatch[1].trim();
      const content = markdown.substring(lastMatch.index + lastMatch[0].length, currentMatch.index).trim();
      sections[name] = content;
    }
    lastMatch = currentMatch;
  }

  // Handle the last section
  if (lastMatch) {
    const name = lastMatch[1].trim();
    const content = markdown.substring(lastMatch.index + lastMatch[0].length).trim();
    sections[name] = content;
  }

  return sections;
}

/**
 * Extract topic from first H1 heading.
 */
function extractTopic(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Untitled Research';
}

/**
 * Extract description from blockquote after H1.
 */
function extractDescription(markdown: string): string {
  const match = markdown.match(/^#\s+.+\n\n>\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * Extract LAST_UPDATED timestamp.
 */
function extractLastUpdated(markdown: string): string {
  const match = markdown.match(/<!-- LAST_UPDATED:([^>]+) -->/);
  return match ? match[1].trim() : '';
}

/**
 * Parse goals section content.
 * Format: `- [ ] goal text` or `- [x] goal text`
 */
function parseGoalsSection(content: string): Array<{ text: string; completed: boolean }> {
  const goals: Array<{ text: string; completed: boolean }> = [];
  const regex = /^- \[([ xX])\]\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    goals.push({
      text: match[2].trim(),
      completed: match[1].toLowerCase() === 'x',
    });
  }
  return goals;
}

/**
 * Parse findings section content.
 * Format: `### Title` followed by `- **Source**: ...`, `- **Recorded**: ...`, and content.
 */
function parseFindingsSection(content: string): ResearchFinding[] {
  if (!content.trim() || content.startsWith('_No findings')) return [];

  const findings: ResearchFinding[] = [];
  // Split by ### headings
  const parts = content.split(/^### /m).filter(s => s.trim());

  for (const part of parts) {
    const lines = part.split('\n');
    const title = lines[0].trim();
    let source: string | undefined;
    const contentLines: string[] = [];
    let recordedAt = new Date().toISOString();

    for (const line of lines.slice(1)) {
      if (line.startsWith('- **Source**:') || line.startsWith('- **来源**:')) {
        source = line.replace(/^-\s*\*\*(?:Source|来源)\*\*:\s*/, '').trim();
      } else if (line.startsWith('- **Recorded**:') || line.startsWith('- **记录时间**:')) {
        const dateStr = line.replace(/^-\s*\*\*(?:Recorded|记录时间)\*\*:\s*/, '').trim();
        try { recordedAt = new Date(dateStr).toISOString(); } catch { /* keep default */ }
      } else if (line.trim()) {
        contentLines.push(line.trim());
      }
    }

    findings.push({
      title,
      source,
      content: contentLines.join('\n'),
      recordedAt,
    });
  }

  return findings;
}

/**
 * Parse questions section content.
 * Format: `- [ ] question text` or `- [x] question text — resolution`
 */
function parseQuestionsSection(content: string): ResearchQuestion[] {
  if (!content.trim() || content.startsWith('_No questions')) return [];

  const questions: ResearchQuestion[] = [];
  const regex = /^- \[([ xX])\]\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const resolved = match[1].toLowerCase() === 'x';
    const text = match[2].trim();
    const now = new Date().toISOString();

    if (resolved) {
      const resolvedMatch = text.match(/^(.+?)\s*[—–-]+\s*(.+)$/);
      questions.push({
        text: resolvedMatch ? resolvedMatch[1].trim() : text,
        resolved: true,
        resolution: resolvedMatch ? resolvedMatch[2].trim() : '',
        addedAt: now,
        resolvedAt: now,
      });
    } else {
      questions.push({
        text,
        resolved: false,
        addedAt: now,
      });
    }
  }
  return questions;
}

/**
 * Extract conclusion text from section content.
 */
function extractConclusionText(content: string): string | undefined {
  const trimmed = content.trim();
  if (!trimmed || trimmed === '_Research not yet concluded_') return undefined;
  return trimmed;
}

/**
 * Parse resources section content.
 * Format: `- [name](url)`
 */
function parseResourcesSection(content: string): Array<{ name: string; url: string }> {
  if (!content.trim() || content.startsWith('- _No resources')) return [];

  const resources: Array<{ name: string; url: string }> = [];
  const regex = /^- \[([^\]]+)\]\(([^)]+)\)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    resources.push({ name: match[1].trim(), url: match[2].trim() });
  }
  return resources;
}

// ============================================================================
// ResearchStateFile Class
// ============================================================================

/**
 * Research State File Manager.
 *
 * Manages the lifecycle of RESEARCH.md files in research working directories.
 * Provides methods for initializing, reading, and updating research state.
 *
 * This class is designed to be stateless — all state is persisted in the
 * RESEARCH.md file. Multiple instances can safely operate on different files.
 *
 * The update strategy is simple: parse → mutate state → regenerate entire file.
 * This avoids complex section-by-section patching and ensures consistent output.
 *
 * @example
 * ```typescript
 * const rsf = new ResearchStateFile();
 *
 * // Initialize a new RESEARCH.md
 * await rsf.initialize('/workspace/research/ai-safety', {
 *   topic: 'AI Safety Research',
 *   description: 'Investigating alignment and safety...',
 *   goals: ['Survey existing literature', 'Identify key risks'],
 * });
 *
 * // Add a finding
 * await rsf.addFinding('/workspace/research/ai-safety', {
 *   title: 'Alignment Tax',
 *   source: 'https://arxiv.org/abs/2307.15217',
 *   content: 'Additional cost of ensuring AI system alignment...',
 * });
 *
 * // Read current state
 * const state = await rsf.read('/workspace/research/ai-safety');
 * console.log(state.findings.length); // 1
 * ```
 */
export class ResearchStateFile {
  private readonly log: Logger;

  constructor(options?: { logger?: Logger }) {
    this.log = options?.logger || logger;
  }

  /**
   * Initialize a RESEARCH.md file in the given research directory.
   *
   * Creates the file with the standard template if it doesn't exist.
   * If the file already exists, it is NOT overwritten.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param options - Initialization options (topic, description, goals, resources)
   * @returns Result with file path and creation status
   * @throws Error if researchDir is not an absolute path
   */
  async initialize(
    researchDir: string,
    options: ResearchStateInitOptions,
  ): Promise<ResearchStateInitResult> {
    if (!path.isAbsolute(researchDir)) {
      throw new Error(
        `researchDir must be an absolute path, got: "${researchDir}". ` +
        'Use path.resolve() to convert relative paths.'
      );
    }

    if (!options.topic || !options.topic.trim()) {
      throw new Error('Research topic is required for RESEARCH.md initialization.');
    }

    const filePath = path.join(researchDir, 'RESEARCH.md');

    // Check if file already exists
    try {
      await fs.access(filePath);
      this.log.debug({ filePath }, 'RESEARCH.md already exists, keeping existing');
      return { filePath, created: false };
    } catch {
      // File doesn't exist, create it
    }

    // Ensure directory exists
    await fs.mkdir(researchDir, { recursive: true });

    // Build initial state and generate markdown
    const state: ResearchState = {
      topic: options.topic.trim(),
      description: options.description || '',
      goals: (options.goals || []).map(g => ({ text: g, completed: false })),
      findings: [],
      questions: [],
      resources: options.resources || [],
      archived: false,
      lastUpdatedAt: new Date().toISOString(),
    };

    const content = generateMarkdown(state);
    await fs.writeFile(filePath, content, 'utf-8');

    this.log.info({ filePath, topic: options.topic }, 'Created RESEARCH.md');
    return { filePath, created: true };
  }

  /**
   * Read and parse a RESEARCH.md file.
   *
   * @param researchDir - Absolute path to the research working directory
   * @returns Parsed research state
   * @throws Error if file doesn't exist
   */
  async read(researchDir: string): Promise<ResearchState> {
    const filePath = path.join(researchDir, 'RESEARCH.md');

    let markdown: string;
    try {
      markdown = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(
        `RESEARCH.md not found at "${filePath}". ` +
        'Call initialize() first to create the file.'
      );
    }

    return this.parse(markdown);
  }

  /**
   * Parse RESEARCH.md markdown content into a structured state object.
   *
   * This is a pure function that can be used without file I/O,
   * e.g., for testing or processing markdown strings.
   *
   * @param markdown - RESEARCH.md content
   * @returns Parsed research state
   */
  parse(markdown: string): ResearchState {
    return parseMarkdown(markdown);
  }

  /**
   * Add a new finding to the RESEARCH.md.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param finding - Finding to add
   * @throws Error if file doesn't exist
   */
  async addFinding(researchDir: string, finding: AddFindingOptions): Promise<void> {
    await this.update(researchDir, (state) => {
      state.findings.push({
        title: finding.title,
        source: finding.source,
        content: finding.content,
        recordedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Add a new question to investigate.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param question - Question text
   * @throws Error if file doesn't exist
   */
  async addQuestion(researchDir: string, question: string): Promise<void> {
    await this.update(researchDir, (state) => {
      state.questions.push({
        text: question,
        resolved: false,
        addedAt: new Date().toISOString(),
      });
    });
  }

  /**
   * Resolve a question by marking it as answered.
   *
   * Optionally adds resolution notes and a related finding.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param questionIndex - Zero-based index of the question to resolve
   * @param resolution - Optional resolution notes
   * @param relatedFinding - Optional finding to add when resolving the question
   * @throws Error if question index is out of bounds
   */
  async resolveQuestion(
    researchDir: string,
    questionIndex: number,
    resolution?: string,
    relatedFinding?: AddFindingOptions,
  ): Promise<void> {
    await this.update(researchDir, (state) => {
      if (questionIndex < 0 || questionIndex >= state.questions.length) {
        throw new Error(
          `Question index ${questionIndex} out of bounds. ` +
          `There are ${state.questions.length} questions.`
        );
      }

      const question = state.questions[questionIndex];
      question.resolved = true;
      question.resolution = resolution || '';
      question.resolvedAt = new Date().toISOString();

      // If a related finding is provided, add it
      if (relatedFinding) {
        state.findings.push({
          title: relatedFinding.title,
          source: relatedFinding.source,
          content: relatedFinding.content,
          recordedAt: new Date().toISOString(),
        });
      }
    });
  }

  /**
   * Toggle a research goal's completion status.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param goalIndex - Zero-based index of the goal
   * @param completed - Whether the goal is completed
   * @throws Error if goal index is out of bounds
   */
  async toggleGoal(researchDir: string, goalIndex: number, completed: boolean): Promise<void> {
    await this.update(researchDir, (state) => {
      if (goalIndex < 0 || goalIndex >= state.goals.length) {
        throw new Error(
          `Goal index ${goalIndex} out of bounds. ` +
          `There are ${state.goals.length} goals.`
        );
      }
      state.goals[goalIndex].completed = completed;
    });
  }

  /**
   * Add a new research goal.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param goal - Goal text
   * @throws Error if file doesn't exist
   */
  async addGoal(researchDir: string, goal: string): Promise<void> {
    await this.update(researchDir, (state) => {
      state.goals.push({ text: goal, completed: false });
    });
  }

  /**
   * Add a research conclusion.
   *
   * When a conclusion is added, the research is considered archived.
   * The conclusion replaces any existing conclusion content.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param conclusion - Research conclusion text
   * @throws Error if file doesn't exist
   */
  async conclude(researchDir: string, conclusion: string): Promise<void> {
    await this.update(researchDir, (state) => {
      state.conclusion = conclusion;
      state.archived = true;
    });
  }

  /**
   * Add a related resource link.
   *
   * @param researchDir - Absolute path to the research working directory
   * @param resource - Resource to add
   * @throws Error if file doesn't exist
   */
  async addResource(researchDir: string, resource: AddResourceOptions): Promise<void> {
    await this.update(researchDir, (state) => {
      // Avoid duplicate resources (by URL)
      if (state.resources.some(r => r.url === resource.url)) {
        this.log.debug({ url: resource.url }, 'Resource already exists, skipping');
        return;
      }
      state.resources.push({ name: resource.name, url: resource.url });
    });
  }

  /**
   * Check if a RESEARCH.md file exists in the given directory.
   *
   * @param researchDir - Absolute path to the research working directory
   * @returns true if RESEARCH.md exists
   */
  async exists(researchDir: string): Promise<boolean> {
    const filePath = path.join(researchDir, 'RESEARCH.md');
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private: Generic Update
  // ============================================================================

  /**
   * Generic updater: read → parse → mutate → regenerate → write.
   *
   * All mutations go through this single method to ensure consistency.
   */
  private async update(
    researchDir: string,
    mutate: (state: ResearchState) => void,
  ): Promise<void> {
    const filePath = path.join(researchDir, 'RESEARCH.md');

    let markdown: string;
    try {
      markdown = await fs.readFile(filePath, 'utf-8');
    } catch {
      throw new Error(
        `RESEARCH.md not found at "${filePath}". ` +
        'Call initialize() first to create the file.'
      );
    }

    const state = parseMarkdown(markdown);
    mutate(state);
    const updated = generateMarkdown(state);

    await fs.writeFile(filePath, updated, 'utf-8');
    this.log.debug({ filePath }, 'Updated RESEARCH.md');
  }
}

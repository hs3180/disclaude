/**
 * ETA Task Records - Markdown-based task execution records.
 *
 * Issue #1234: Task ETA Estimation System
 *
 * Uses Markdown format to store task records with reasoning process.
 * This is intentionally unstructured to allow natural evolution of the format.
 *
 * @module agents/eta-task-records
 */

import { createLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';

const logger = createLogger('ETATaskRecords');

/**
 * Task record data for logging.
 */
export interface TaskRecordEntry {
  /** Task description/title */
  taskDescription: string;
  /** Task type classification */
  taskType: string;
  /** Estimated time in human-readable format */
  estimatedTime: string;
  /** Estimated time in seconds */
  estimatedSeconds: number;
  /** Reasoning for the estimate */
  estimationReasoning: string;
  /** Actual time in human-readable format */
  actualTime: string;
  /** Actual time in seconds */
  actualSeconds: number;
  /** Post-task review/reflection */
  review: string;
  /** Key factors that affected execution */
  keyFactors?: string[];
}

/**
 * ETA Task Records Storage.
 *
 * Manages task-records.md file with Markdown format.
 */
export class ETATaskRecords {
  private readonly recordsFile: string;
  private initialized = false;

  constructor() {
    const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
    const claudeDir = resolve(workspaceDir, '.claude');
    this.recordsFile = join(claudeDir, 'task-records.md');
  }

  /**
   * Initialize storage - ensure directory and file exist.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const claudeDir = resolve(this.recordsFile, '..');
      await fs.mkdir(claudeDir, { recursive: true });

      // Check if file exists, create with header if not
      try {
        await fs.access(this.recordsFile);
      } catch {
        await this.createInitialFile();
      }

      this.initialized = true;
      logger.info({ file: this.recordsFile }, 'ETA task records initialized');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize ETA task records');
      throw error;
    }
  }

  /**
   * Create initial task-records.md with header.
   */
  private async createInitialFile(): Promise<void> {
    const header = `# 任务记录

此文件记录任务的执行信息，用于 ETA 预估学习。

格式说明：
- 每个任务记录包含估计时间、实际时间、推理过程和复盘
- 通过自然语言记录，便于 LLM 理解和检索

---

`;
    await fs.writeFile(this.recordsFile, header, 'utf-8');
  }

  /**
   * Record a task execution to the Markdown file.
   */
  async recordTask(entry: TaskRecordEntry): Promise<void> {
    await this.ensureInitialized();

    const date = new Date().toISOString().split('T')[0];
    const recordMarkdown = this.formatTaskRecord(date, entry);

    // Append to file
    await fs.appendFile(this.recordsFile, recordMarkdown, 'utf-8');

    logger.info({
      taskType: entry.taskType,
      estimated: entry.estimatedSeconds,
      actual: entry.actualSeconds,
    }, 'Recorded task to Markdown');
  }

  /**
   * Format a task record as Markdown.
   */
  private formatTaskRecord(date: string, entry: TaskRecordEntry): string {
    const factors = entry.keyFactors?.length
      ? `\n- **关键因素**: ${entry.keyFactors.join(', ')}`
      : '';

    return `
## ${date} ${entry.taskDescription.slice(0, 50)}${entry.taskDescription.length > 50 ? '...' : ''}

- **类型**: ${entry.taskType}
- **估计时间**: ${entry.estimatedTime}
- **估计依据**: ${entry.estimationReasoning}
- **实际时间**: ${entry.actualTime}
- **复盘**: ${entry.review}${factors}

`;
  }

  /**
   * Read all task records as raw Markdown.
   */
  async readRecords(): Promise<string> {
    await this.ensureInitialized();
    return fs.readFile(this.recordsFile, 'utf-8');
  }

  /**
   * Search for similar tasks by keywords.
   * Returns relevant task record sections.
   */
  async searchSimilarTasks(keywords: string[], limit = 5): Promise<string[]> {
    await this.ensureInitialized();

    const content = await this.readRecords();
    const sections = content.split(/^## /m).filter(s => s.trim());

    const results: { section: string; score: number }[] = [];

    for (const section of sections) {
      if (section.startsWith('# 任务记录') || section.startsWith('---')) {
        continue;
      }

      // Simple keyword matching
      const lowerSection = section.toLowerCase();
      let score = 0;
      for (const keyword of keywords) {
        if (lowerSection.includes(keyword.toLowerCase())) {
          score++;
        }
      }

      if (score > 0) {
        results.push({ section: '## ' + section.trim(), score });
      }
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(r => r.section);
  }

  /**
   * Get recent task records.
   */
  async getRecentRecords(count = 10): Promise<string> {
    await this.ensureInitialized();

    const content = await this.readRecords();
    const sections = content.split(/^## /m).filter(s => s.trim());

    // Skip header sections and get recent ones
    const taskSections = sections.filter(s =>
      !s.startsWith('# 任务记录') &&
      !s.startsWith('---') &&
      s.includes('**类型**')
    );

    return taskSections.slice(-count).map(s => '## ' + s.trim()).join('\n\n');
  }

  /**
   * Get file path for external access.
   */
  getFilePath(): string {
    return this.recordsFile;
  }

  /**
   * Ensure storage is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}

/**
 * Global ETA task records instance.
 */
export const etaTaskRecords = new ETATaskRecords();

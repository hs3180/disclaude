/**
 * Schedule File Scanner - Scans and parses schedule markdown files.
 *
 * Scans the schedules/ directory for .md files with YAML frontmatter.
 * Each file represents a scheduled task with metadata and prompt.
 *
 * ## File Format
 *
 * ```markdown
 * ---
 * name: Daily Report
 * cron: "0 9 * * *"
 * enabled: true
 * blocking: true
 * chatId: oc_xxx
 * createdBy: ou_xxx
 * ---
 *
 * Task prompt content here...
 * ```
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './schedule-manager.js';

const logger = createLogger('ScheduleFileScanner');

/**
 * Schedule file with additional metadata.
 */
export interface ScheduleFileTask extends ScheduledTask {
  /** Source file path */
  sourceFile: string;
  /** File modification time */
  fileMtime: Date;
}

/**
 * ScheduleFileScanner options.
 */
export interface ScheduleFileScannerOptions {
  /** Directory to scan for schedule files */
  schedulesDir: string;
}

/**
 * Parse YAML frontmatter from schedule content.
 *
 * Extracts:
 * - name (required)
 * - cron (required)
 * - enabled (optional, default: true)
 * - blocking (optional, default: false)
 * - chatId (required)
 * - createdBy (optional)
 * - createdAt (optional)
 *
 * @param content - Raw schedule file content
 * @returns Parsed frontmatter and content start position
 */
function parseScheduleFrontmatter(content: string): {
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
    if (colonIndex === -1) { continue; }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    switch (key) {
      case 'name':
      case 'cron':
      case 'chatId':
      case 'createdBy':
      case 'createdAt':
      case 'lastExecutedAt':
        // Remove quotes if present
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
        break;
      case 'enabled':
      case 'blocking':
        frontmatter[key] = value === 'true';
        break;
    }
  }

  return {
    frontmatter,
    contentStart: match[0].length
  };
}

/**
 * Generate task ID from file name.
 */
function generateTaskId(fileName: string): string {
  const baseName = path.basename(fileName, '.md');
  return `schedule-${baseName}`;
}

/**
 * ScheduleFileScanner - Scans and parses schedule markdown files.
 */
export class ScheduleFileScanner {
  private schedulesDir: string;

  constructor(options: ScheduleFileScannerOptions) {
    this.schedulesDir = options.schedulesDir;
    logger.info({ schedulesDir: this.schedulesDir }, 'ScheduleFileScanner initialized');
  }

  /**
   * Ensure the schedules directory exists.
   */
  async ensureDir(): Promise<void> {
    await fs.mkdir(this.schedulesDir, { recursive: true });
  }

  /**
   * Scan all .md files and return parsed tasks.
   */
  async scanAll(): Promise<ScheduleFileTask[]> {
    await this.ensureDir();

    const tasks: ScheduleFileTask[] = [];

    try {
      const files = await fs.readdir(this.schedulesDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));

      for (const file of mdFiles) {
        const filePath = path.join(this.schedulesDir, file);
        const task = await this.parseFile(filePath);
        if (task) {
          tasks.push(task);
        }
      }

      logger.info({ count: tasks.length }, 'Scanned schedule files');
      return tasks;

    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.debug('Schedules directory does not exist, returning empty');
        return [];
      }
      throw error;
    }
  }

  /**
   * Parse a single schedule file.
   *
   * @param filePath - Path to the schedule file
   * @returns Parsed task or null if invalid
   */
  async parseFile(filePath: string): Promise<ScheduleFileTask | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const stats = await fs.stat(filePath);
      const { frontmatter, contentStart } = parseScheduleFrontmatter(content);

      // Validate required fields
      if (!frontmatter['name'] || !frontmatter['cron'] || !frontmatter['chatId']) {
        logger.warn({ filePath }, 'Schedule file missing required fields (name, cron, chatId)');
        return null;
      }

      const prompt = content.slice(contentStart).trim();
      const fileName = path.basename(filePath);

      const task: ScheduleFileTask = {
        id: generateTaskId(fileName),
        name: frontmatter['name'] as string,
        cron: frontmatter['cron'] as string,
        chatId: frontmatter['chatId'] as string,
        prompt,
        enabled: (frontmatter['enabled'] as boolean) ?? true,
        blocking: (frontmatter['blocking'] as boolean) ?? false,
        createdBy: frontmatter['createdBy'] as string | undefined,
        createdAt: (frontmatter['createdAt'] as string) || stats.birthtime.toISOString(),
        lastExecutedAt: frontmatter['lastExecutedAt'] as string | undefined,
        sourceFile: filePath,
        fileMtime: stats.mtime,
      };

      logger.debug({ taskId: task.id, name: task.name }, 'Parsed schedule file');
      return task;

    } catch (error) {
      logger.error({ err: error, filePath }, 'Failed to parse schedule file');
      return null;
    }
  }

  /**
   * Write a task to a markdown file.
   *
   * @param task - Task to write
   * @returns The file path
   */
  async writeTask(task: ScheduledTask): Promise<string> {
    await this.ensureDir();

    // Use task ID to generate file name (task.id = "schedule-{slug}")
    // This ensures file name matches task ID for consistent deletion
    const fileName = task.id.startsWith('schedule-')
      ? `${task.id.slice('schedule-'.length)}.md`
      : `${task.id}.md`;
    const filePath = path.join(this.schedulesDir, fileName);

    const frontmatter = [
      '---',
      `name: "${task.name}"`,
      `cron: "${task.cron}"`,
      `enabled: ${task.enabled}`,
      `blocking: ${task.blocking ?? false}`,
      `chatId: ${task.chatId}`,
    ];

    if (task.createdBy) {
      frontmatter.push(`createdBy: ${task.createdBy}`);
    }
    if (task.createdAt) {
      frontmatter.push(`createdAt: "${task.createdAt}"`);
    }
    if (task.lastExecutedAt) {
      frontmatter.push(`lastExecutedAt: "${task.lastExecutedAt}"`);
    }

    frontmatter.push('---', '');

    const content = frontmatter.join('\n') + task.prompt;

    await fs.writeFile(filePath, content, 'utf-8');
    logger.info({ taskId: task.id, filePath }, 'Wrote schedule file');

    return filePath;
  }

  /**
   * Delete a task file by task ID.
   *
   * @param taskId - Task ID to delete
   * @returns true if deleted, false if not found
   */
  async deleteTask(taskId: string): Promise<boolean> {
    // Task ID format: schedule-{slug}
    if (!taskId.startsWith('schedule-')) {
      return false;
    }

    const slug = taskId.slice('schedule-'.length);
    const filePath = path.join(this.schedulesDir, `${slug}.md`);

    try {
      await fs.unlink(filePath);
      logger.info({ taskId, filePath }, 'Deleted schedule file');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get the file path for a task ID.
   */
  getFilePath(taskId: string): string {
    const slug = taskId.startsWith('schedule-')
      ? taskId.slice('schedule-'.length)
      : taskId;
    return path.join(this.schedulesDir, `${slug}.md`);
  }
}

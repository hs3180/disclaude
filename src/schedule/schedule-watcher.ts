/**
 * Schedule Watcher - Scans and watches schedule markdown files.
 *
 * This module combines:
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
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

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './schedule-manager.js';

const logger = createLogger('ScheduleWatcher');

// ============================================================================
// Shared Types
// ============================================================================

/**
 * Schedule file with additional metadata.
 */
export interface ScheduleFileTask extends ScheduledTask {
  /** Source file path */
  sourceFile: string;
  /** File modification time */
  fileMtime: Date;
}

// ============================================================================
// Shared Utility Functions
// ============================================================================

/**
 * Parse YAML frontmatter from schedule content.
 *
 * Extracts:
 * - name (required)
 * - cron (required)
 * - enabled (optional, default: true)
 * - blocking (optional, default: true)
 * - cooldownPeriod (optional, cooldown in milliseconds)
 * - chatId (required)
 * - createdBy (optional)
 * - createdAt (optional)
 * - lastExecutedAt (optional)
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
      case 'cooldownPeriod':
        // Parse as integer (milliseconds)
        frontmatter[key] = parseInt(value, 10);
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

// ============================================================================
// ScheduleFileScanner
// ============================================================================

/**
 * ScheduleFileScanner options.
 */
export interface ScheduleFileScannerOptions {
  /** Directory to scan for schedule files */
  schedulesDir: string;
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
    await fsPromises.mkdir(this.schedulesDir, { recursive: true });
  }

  /**
   * Scan all .md files and return parsed tasks.
   */
  async scanAll(): Promise<ScheduleFileTask[]> {
    await this.ensureDir();

    const tasks: ScheduleFileTask[] = [];

    try {
      const files = await fsPromises.readdir(this.schedulesDir);
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
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const stats = await fsPromises.stat(filePath);
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
        blocking: (frontmatter['blocking'] as boolean) ?? true,
        cooldownPeriod: frontmatter['cooldownPeriod'] as number | undefined,
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
      `blocking: ${task.blocking ?? true}`,
      `chatId: ${task.chatId}`,
    ];

    if (task.cooldownPeriod) {
      frontmatter.push(`cooldownPeriod: ${task.cooldownPeriod}`);
    }
    if (task.createdBy) {
      frontmatter.push(`createdBy: ${task.createdBy}`);
    }
    if (task.createdAt) {
      frontmatter.push(`createdAt: "${task.createdAt}"`);
    }
    // Note: lastExecutedAt is intentionally NOT written to file
    // Execution state is tracked in memory only to prevent file contention

    frontmatter.push('---', '');

    const content = frontmatter.join('\n') + task.prompt;

    await fsPromises.writeFile(filePath, content, 'utf-8');
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
      await fsPromises.unlink(filePath);
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

// ============================================================================
// ScheduleFileWatcher
// ============================================================================

/**
 * Callback when a file is added.
 */
export type OnFileAdded = (task: ScheduleFileTask) => void;

/**
 * Callback when a file is changed.
 */
export type OnFileChanged = (task: ScheduleFileTask) => void;

/**
 * Callback when a file is removed.
 */
export type OnFileRemoved = (taskId: string, filePath: string) => void;

/**
 * ScheduleFileWatcher options.
 */
export interface ScheduleFileWatcherOptions {
  /** Directory to watch */
  schedulesDir: string;
  /** Callback when a file is added */
  onFileAdded: OnFileAdded;
  /** Callback when a file is changed */
  onFileChanged: OnFileChanged;
  /** Callback when a file is removed */
  onFileRemoved: OnFileRemoved;
  /** Debounce interval in ms (default: 100) */
  debounceMs?: number;
}

/**
 * ScheduleFileWatcher - Watches schedule directory for changes.
 */
export class ScheduleFileWatcher {
  private schedulesDir: string;
  private onFileAdded: OnFileAdded;
  private onFileChanged: OnFileChanged;
  private onFileRemoved: OnFileRemoved;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private running = false;

  constructor(options: ScheduleFileWatcherOptions) {
    this.schedulesDir = options.schedulesDir;
    this.onFileAdded = options.onFileAdded;
    this.onFileChanged = options.onFileChanged;
    this.onFileRemoved = options.onFileRemoved;
    this.debounceMs = options.debounceMs ?? 100;
  }

  /**
   * Start watching the schedules directory.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('File watcher already running');
      return;
    }

    // Ensure directory exists
    await fsPromises.mkdir(this.schedulesDir, { recursive: true });

    try {
      this.watcher = fs.watch(
        this.schedulesDir,
        { persistent: true, recursive: false },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'File watcher error');
      });

      this.running = true;
      logger.info({ schedulesDir: this.schedulesDir }, 'File watcher started');

    } catch (error) {
      logger.error({ err: error }, 'Failed to start file watcher');
      throw error;
    }
  }

  /**
   * Stop watching.
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    this.running = false;
    logger.info('File watcher stopped');
  }

  /**
   * Check if watcher is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Handle file system event with debouncing.
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename || !filename.endsWith('.md')) {
      return;
    }

    const filePath = path.join(this.schedulesDir, filename);
    logger.debug({ eventType, filename }, 'File event received');

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Debounce the event
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.processFileEvent(eventType, filePath, filename);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process the file event after debouncing.
   */
  private async processFileEvent(eventType: string, filePath: string, filename: string): Promise<void> {
    const taskId = generateTaskId(filename);

    try {
      if (eventType === 'rename') {
        // Check if file exists to determine if it was added or removed
        const exists = await this.fileExists(filePath);

        if (exists) {
          // File added or renamed to this name
          const task = await this.parseFile(filePath);
          if (task) {
            logger.info({ taskId, filename }, 'Schedule file added');
            this.onFileAdded(task);
          }
        } else {
          // File removed
          logger.info({ taskId, filename }, 'Schedule file removed');
          this.onFileRemoved(taskId, filePath);
        }
      } else if (eventType === 'change') {
        // File modified
        const task = await this.parseFile(filePath);
        if (task) {
          logger.info({ taskId, filename }, 'Schedule file changed');
          this.onFileChanged(task);
        }
      }
    } catch (error) {
      logger.error({ err: error, filePath, eventType }, 'Error processing file event');
    }
  }

  /**
   * Check if a file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a schedule file (uses shared parseScheduleFrontmatter).
   */
  private async parseFile(filePath: string): Promise<ScheduleFileTask | null> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const stats = await fsPromises.stat(filePath);

      const { frontmatter, contentStart } = parseScheduleFrontmatter(content);
      if (!frontmatter['name'] || !frontmatter['cron'] || !frontmatter['chatId']) {
        return null;
      }

      const prompt = content.slice(contentStart).trim();
      const fileName = path.basename(filePath);

      return {
        id: generateTaskId(fileName),
        name: frontmatter['name'] as string,
        cron: frontmatter['cron'] as string,
        chatId: frontmatter['chatId'] as string,
        prompt,
        enabled: (frontmatter['enabled'] as boolean) ?? true,
        blocking: (frontmatter['blocking'] as boolean) ?? true,
        cooldownPeriod: frontmatter['cooldownPeriod'] as number | undefined,
        createdBy: frontmatter['createdBy'] as string | undefined,
        createdAt: (frontmatter['createdAt'] as string) || stats.birthtime.toISOString(),
        sourceFile: filePath,
        fileMtime: stats.mtime,
      };
    } catch (error) {
      logger.error({ err: error, filePath }, 'Failed to parse schedule file');
      return null;
    }
  }
}

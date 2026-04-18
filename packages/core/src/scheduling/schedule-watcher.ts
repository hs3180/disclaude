/**
 * Schedule Watcher - Scans and watches schedule markdown files.
 *
 * This module combines:
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 *
 * ## File Format (Issue #2526: subdirectory structure)
 *
 * Schedules are organized in subdirectories, similar to skills:
 * ```
 * schedules/
 * ├── daily-report/
 * │   ├── SCHEDULE.md      ← schedule definition
 * │   └── report.ts        ← optional implementation
 * ├── pr-scanner/
 * │   └── SCHEDULE.md
 * └── ...
 * ```
 *
 * Legacy flat format (backward compatible):
 * ```
 * schedules/
 * ├── daily-report.md
 * └── weekly-summary.md
 * ```
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
 *
 * Issue #1041: Migrated from @disclaude/worker-node to @disclaude/core.
 * Issue #2526: Added subdirectory + SCHEDULE.md structure support.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask } from './scheduled-task.js';

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
 * Strip matched leading/trailing quotes from a value.
 * Only strips if the first and last characters are a matching quote pair.
 * This prevents incorrect stripping of nested quotes (e.g., "'glm'" → "'glm'" instead of "glm'").
 *
 * @param value - The value to strip quotes from
 * @returns The value with matched outer quotes removed, or the original value
 */
function stripQuotes(value: string): string {
  const [first, ...rest] = value;
  const last = rest[rest.length - 1];
  if ((first === '"' || first === "'") && first === last && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse YAML frontmatter from schedule content.
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
      case 'model':
        frontmatter[key] = stripQuotes(value);
        break;
      case 'enabled':
      case 'blocking':
        frontmatter[key] = value === 'true';
        break;
      case 'cooldownPeriod':
        frontmatter[key] = parseInt(value, 10);
        break;
    }
  }

  return { frontmatter, contentStart: match[0].length };
}

/** Name of the schedule definition file inside each subdirectory. */
const SCHEDULE_FILE = 'SCHEDULE.md';

/**
 * Generate task ID from a file name or subdirectory name.
 *
 * For subdirectory SCHEDULE.md files, the caller should pass the directory name.
 * For legacy flat files, pass the file name (e.g., "daily-report.md").
 */
function generateTaskId(name: string): string {
  const baseName = path.basename(name, '.md');
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
   * Scan all schedule files and return parsed tasks.
   *
   * Issue #2526: Discovers schedules from subdirectories first
   * (schedules/<name>/SCHEDULE.md), then falls back to legacy flat
   * .md files for backward compatibility.
   */
  async scanAll(): Promise<ScheduleFileTask[]> {
    await this.ensureDir();

    const tasks: ScheduleFileTask[] = [];

    try {
      const entries = await fsPromises.readdir(this.schedulesDir, { withFileTypes: true });

      // Phase 1: Subdirectory discovery (primary, Issue #2526)
      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }

        const scheduleFile = path.join(this.schedulesDir, entry.name, SCHEDULE_FILE);
        const task = await this.parseFile(scheduleFile);
        if (task) {
          tasks.push(task);
        }
      }

      // Phase 2: Legacy flat .md files (backward compat)
      const mdFiles = entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name);

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
   * Issue #2526: Derives task ID from the parent directory name
   * for SCHEDULE.md files, or from the filename for legacy flat files.
   */
  async parseFile(filePath: string): Promise<ScheduleFileTask | null> {
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const stats = await fsPromises.stat(filePath);
      const { frontmatter, contentStart } = parseScheduleFrontmatter(content);

      if (!frontmatter['name'] || !frontmatter['cron'] || !frontmatter['chatId']) {
        logger.warn({ filePath }, 'Schedule file missing required fields (name, cron, chatId)');
        return null;
      }

      const prompt = content.slice(contentStart).trim();

      // Issue #2526: Derive ID from parent directory for SCHEDULE.md,
      // or from filename for legacy flat .md files.
      const baseName = path.basename(filePath);
      const idSource = baseName === SCHEDULE_FILE
        ? path.basename(path.dirname(filePath))
        : baseName;

      const task: ScheduleFileTask = {
        id: generateTaskId(idSource),
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
        model: frontmatter['model'] as string | undefined,
        sourceFile: filePath,
        fileMtime: stats.mtime,
      };

      // Issue #1338: Warn if model is specified but looks suspicious (e.g., empty)
      if (task.model && task.model.trim().length === 0) {
        logger.warn({ taskId: task.id, name: task.name }, 'Schedule task has empty model value, will be ignored');
      } else if (task.model) {
        logger.info({ taskId: task.id, name: task.name, model: task.model }, 'Schedule task will use model override');
      }

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
   * Issue #2526: Writes to subdirectory structure:
   * schedules/<name>/SCHEDULE.md
   */
  async writeTask(task: ScheduledTask): Promise<string> {
    const slug = task.id.startsWith('schedule-')
      ? task.id.slice('schedule-'.length)
      : task.id;
    const subDir = path.join(this.schedulesDir, slug);
    await fsPromises.mkdir(subDir, { recursive: true });

    const filePath = path.join(subDir, SCHEDULE_FILE);

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
    if (task.model) {
      frontmatter.push(`model: "${task.model}"`);
    }

    frontmatter.push('---', '');
    const content = frontmatter.join('\n') + task.prompt;

    await fsPromises.writeFile(filePath, content, 'utf-8');
    logger.info({ taskId: task.id, filePath }, 'Wrote schedule file');

    return filePath;
  }

  /**
   * Delete a task file by task ID.
   *
   * Issue #2526: Tries subdirectory SCHEDULE.md first, then
   * falls back to legacy flat .md file.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    if (!taskId.startsWith('schedule-')) {
      return false;
    }

    const slug = taskId.slice('schedule-'.length);

    // Try subdirectory SCHEDULE.md first (Issue #2526)
    const subDirPath = path.join(this.schedulesDir, slug, SCHEDULE_FILE);
    try {
      await fsPromises.unlink(subDirPath);
      logger.info({ taskId, filePath: subDirPath }, 'Deleted schedule file (subdirectory)');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // Fallback: legacy flat .md file
    const flatPath = path.join(this.schedulesDir, `${slug}.md`);
    try {
      await fsPromises.unlink(flatPath);
      logger.info({ taskId, filePath: flatPath }, 'Deleted schedule file (flat)');
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
   *
   * Issue #2526: Returns subdirectory path: schedules/<name>/SCHEDULE.md
   */
  getFilePath(taskId: string): string {
    const slug = taskId.startsWith('schedule-')
      ? taskId.slice('schedule-'.length)
      : taskId;
    return path.join(this.schedulesDir, slug, SCHEDULE_FILE);
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
 *
 * Issue #2526: Watches recursively to catch changes in subdirectories
 * (e.g., schedules/<name>/SCHEDULE.md).
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
  private fileScanner: ScheduleFileScanner;

  constructor(options: ScheduleFileWatcherOptions) {
    this.schedulesDir = options.schedulesDir;
    this.onFileAdded = options.onFileAdded;
    this.onFileChanged = options.onFileChanged;
    this.onFileRemoved = options.onFileRemoved;
    this.debounceMs = options.debounceMs ?? 100;
    this.fileScanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir });
    logger.info({ schedulesDir: this.schedulesDir }, 'ScheduleFileWatcher initialized');
  }

  /**
   * Start watching the schedules directory.
   *
   * Issue #2526: Uses recursive watching to catch subdirectory changes.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('File watcher already running');
      return;
    }

    await fsPromises.mkdir(this.schedulesDir, { recursive: true });

    try {
      this.watcher = fs.watch(
        this.schedulesDir,
        { persistent: true, recursive: true },
        (eventType, filename) => {
          this.handleFileEvent(eventType, filename);
        }
      );

      this.watcher.on('error', (error) => {
        logger.error({ err: error }, 'File watcher error');
      });

      this.running = true;
      logger.info({ schedulesDir: this.schedulesDir }, 'File watcher started (recursive)');

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
   *
   * Issue #2526: Handles both subdirectory paths (e.g., "daily-report/SCHEDULE.md")
   * and legacy flat paths (e.g., "daily-report.md").
   */
  private handleFileEvent(eventType: string, filename: string | null): void {
    if (!filename || !filename.endsWith('.md')) {
      return;
    }

    const filePath = path.join(this.schedulesDir, filename);
    logger.debug({ eventType, filename }, 'File event received');

    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.processFileEvent(eventType, filePath, filename);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process the file event after debouncing.
   *
   * Issue #2526: Derives task ID from subdirectory name for
   * SCHEDULE.md files, or from filename for legacy flat files.
   */
  private async processFileEvent(eventType: string, filePath: string, filename: string): Promise<void> {
    // Derive task ID: from subdirectory name if SCHEDULE.md, else from filename
    const baseName = path.basename(filename);
    const idSource = baseName === SCHEDULE_FILE
      ? path.basename(path.dirname(filename))
      : baseName;
    const taskId = generateTaskId(idSource);

    try {
      if (eventType === 'rename') {
        const exists = await this.fileExists(filePath);

        if (exists) {
          const task = await this.fileScanner.parseFile(filePath);
          if (task) {
            logger.info({ taskId, filename }, 'Schedule file added');
            this.onFileAdded(task);
          }
        } else {
          logger.info({ taskId, filename }, 'Schedule file removed');
          this.onFileRemoved(taskId, filePath);
        }
      } else if (eventType === 'change') {
        const task = await this.fileScanner.parseFile(filePath);
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
}

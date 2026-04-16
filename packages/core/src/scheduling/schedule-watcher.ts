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
 *
 * Issue #1041: Migrated from @disclaude/worker-node to @disclaude/core.
 *
 * @module @disclaude/core/scheduling
 */

import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduledTask, WatchConfig } from './scheduled-task.js';

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
 *
 * Issue #1953: Extended to support nested `watch:` block for event-driven triggers.
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
  let inWatchBlock = false;
  const watchLines: string[] = [];

  for (const line of lines) {
    // Detect start of watch block
    if (/^watch\s*:/.test(line)) {
      inWatchBlock = true;
      const inlineValue = line.replace(/^watch\s*:\s*/, '').trim();
      // Handle inline watch config (e.g., `watch: { paths: [...] }`)
      if (inlineValue) {
        watchLines.push(inlineValue);
      }
      continue;
    }

    // If in watch block, collect indented lines
    if (inWatchBlock) {
      if (line.startsWith('  ') || line.startsWith('\t') || line === '') {
        watchLines.push(line);
        continue;
      } else {
        // End of watch block — parse collected lines
        inWatchBlock = false;
        frontmatter['watch'] = parseWatchBlock(watchLines);
      }
    }

    // Regular key-value parsing
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

  // Handle watch block at end of frontmatter
  if (inWatchBlock && watchLines.length > 0) {
    frontmatter['watch'] = parseWatchBlock(watchLines);
  }

  return { frontmatter, contentStart: match[0].length };
}

/**
 * Parse the collected watch block lines into a WatchConfig object.
 *
 * Supported formats:
 * ```yaml
 * watch:
 *   paths:
 *     - "workspace/chats"
 *     - "workspace/other"
 *   events: ["create", "change"]
 *   debounce: 5000
 * ```
 *
 * Also supports compact single-path format:
 * ```yaml
 * watch:
 *   paths: "workspace/chats"
 * ```
 */
function parseWatchBlock(lines: string[]): WatchConfig | undefined {
  const config: WatchConfig = { paths: [] };
  let inPathsList = false;
  const paths: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {continue;}

    // Parse paths list items
    if (inPathsList && line.startsWith('- ')) {
      const pathValue = stripQuotes(line.slice(2).trim());
      if (pathValue) {
        paths.push(pathValue);
      }
      continue;
    }

    // Detect paths key
    if (line.startsWith('paths')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {continue;}
      const value = line.slice(colonIndex + 1).trim();
      if (value.startsWith('[')) {
        // Inline array: paths: ["a", "b"]
        const items = value.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
        config.paths = items;
      } else if (value === '' || value === '|' || value === '>') {
        // Multi-line list format
        inPathsList = true;
      } else {
        // Single path value
        config.paths = [stripQuotes(value)];
      }
      continue;
    }

    // Detect events key
    if (line.startsWith('events')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {continue;}
      const value = line.slice(colonIndex + 1).trim();
      if (value.startsWith('[')) {
        // Inline array: events: ["create", "change"]
        const items = value.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean) as ('create' | 'change' | 'delete')[];
        config.events = items;
      }
      inPathsList = false;
      continue;
    }

    // Detect debounce key
    if (line.startsWith('debounce')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {continue;}
      const value = line.slice(colonIndex + 1).trim();
      const parsed = parseInt(value, 10);
      if (!isNaN(parsed)) {
        config.debounce = parsed;
      }
      inPathsList = false;
      continue;
    }

    // Unknown key — stop paths list
    inPathsList = false;
  }

  // Merge collected list paths
  if (paths.length > 0) {
    config.paths = paths;
  }

  // Only return valid config (at least one path)
  if (config.paths.length === 0) {
    return undefined;
  }

  return config;
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
        model: frontmatter['model'] as string | undefined,
        watch: frontmatter['watch'] as WatchConfig | undefined,
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
   */
  async writeTask(task: ScheduledTask): Promise<string> {
    await this.ensureDir();

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
    if (task.model) {
      frontmatter.push(`model: "${task.model}"`);
    }

    // Issue #1953: Write watch configuration
    if (task.watch && task.watch.paths.length > 0) {
      frontmatter.push('watch:');
      for (const p of task.watch.paths) {
        frontmatter.push(`  - "${p}"`);
      }
      if (task.watch.events && task.watch.events.length > 0) {
        frontmatter.push(`  events: [${task.watch.events.map(e => `"${e}"`).join(', ')}]`);
      }
      if (task.watch.debounce !== undefined) {
        frontmatter.push(`  debounce: ${task.watch.debounce}`);
      }
    }

    frontmatter.push('---', '');
    const content = frontmatter.join('\n') + task.prompt;

    await fsPromises.writeFile(filePath, content, 'utf-8');
    logger.info({ taskId: task.id, filePath }, 'Wrote schedule file');

    return filePath;
  }

  /**
   * Delete a task file by task ID.
   */
  async deleteTask(taskId: string): Promise<boolean> {
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
   */
  private async processFileEvent(eventType: string, filePath: string, filename: string): Promise<void> {
    const taskId = generateTaskId(filename);

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

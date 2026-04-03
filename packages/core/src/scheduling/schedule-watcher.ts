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
import type { ScheduledTask, WatchTrigger } from './scheduled-task.js';

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
 * Parse a YAML array block (multi-line) from frontmatter lines.
 * Handles both compact and expanded forms:
 *
 * Compact:   watch:
 *              - path: "foo"
 *                debounce: 5000
 * Expanded:  watch:
 *              - "foo"
 *
 * @param lines - All frontmatter lines
 * @param startIndex - Index of the array key line (e.g., index of "watch:")
 * @returns Array of parsed items and the next line index after the array
 */
function parseArrayBlock(lines: string[], startIndex: number): { items: Record<string, unknown>[]; nextIndex: number } {
  const items: Record<string, unknown>[] = [];
  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];
    // Check if this line starts a new top-level key (not indented, or indented less than array items)
    const trimmed = line.trimStart();
    if (trimmed === '' || trimmed.startsWith('#')) {
      i++;
      continue;
    }
    // A new top-level key starts with a non-space character
    if (line[0] !== ' ' && line[0] !== '\t' && trimmed.includes(':')) {
      break;
    }

    // Array item starts with "- "
    if (trimmed.startsWith('- ')) {
      const itemContent = trimmed.slice(2).trim();

      // Simple string item: - "path" or - path
      if (!itemContent.includes(':')) {
        items.push({ path: stripQuotes(itemContent) });
        i++;
        continue;
      }

      // Object item: - path: "foo" with possible continuation lines
      const item: Record<string, unknown> = {};
      // Parse inline key-value: - path: "foo" debounce: 5000
      // Or just: - path: "foo"
      const firstColon = itemContent.indexOf(':');
      if (firstColon !== -1) {
        const firstKey = itemContent.slice(0, firstColon).trim();
        let firstValue = itemContent.slice(firstColon + 1).trim();
        // Check if there's more after the first value
        // e.g., "path: 'foo' debounce: 5000"
        const restAfterFirstValue = parseInlineValue(firstValue);
        item[firstKey] = restAfterFirstValue.value;
        // Check for remaining key-value pairs on the same line
        let remaining = restAfterFirstValue.remaining;
        while (remaining) {
          const nextColon = remaining.indexOf(':');
          if (nextColon === -1) break;
          const nextKey = remaining.slice(0, nextColon).trim();
          const nextValueRaw = remaining.slice(nextColon + 1).trim();
          const nextParsed = parseInlineValue(nextValueRaw);
          item[nextKey] = nextParsed.value;
          remaining = nextParsed.remaining;
        }
      }

      // Check continuation lines (indented properties under the array item)
      i++;
      while (i < lines.length) {
        const contLine = lines[i];
        const contTrimmed = contLine.trimStart();
        if (contTrimmed === '' || contLine[0] !== ' ' && contLine[0] !== '\t') {
          break;
        }
        // Must be a continuation: indented key: value
        if (!contTrimmed.startsWith('- ') && contTrimmed.includes(':')) {
          const contColon = contTrimmed.indexOf(':');
          const contKey = contTrimmed.slice(0, contColon).trim();
          const contValue = contTrimmed.slice(contColon + 1).trim();
          if (contKey === 'debounce') {
            item[contKey] = parseInt(contValue, 10);
          } else {
            item[contKey] = stripQuotes(contValue);
          }
          i++;
        } else {
          break;
        }
      }

      items.push(item);
    } else {
      i++;
    }
  }

  return { items, nextIndex: i };
}

/**
 * Parse an inline YAML value, returning the parsed value and any remaining text.
 * Handles quoted strings and plain values.
 */
function parseInlineValue(text: string): { value: unknown; remaining: string | null } {
  if (!text) return { value: '', remaining: null };

  const trimmed = text.trimStart();
  if (!trimmed) return { value: '', remaining: null };

  // Quoted string
  if ((trimmed[0] === '"' || trimmed[0] === "'")) {
    const quote = trimmed[0];
    let end = 1;
    while (end < trimmed.length && trimmed[end] !== quote) {
      if (trimmed[end] === '\\') end++; // skip escaped chars
      end++;
    }
    if (end < trimmed.length) {
      const value = trimmed.slice(1, end);
      const remaining = trimmed.slice(end + 1).trim() || null;
      return { value, remaining };
    }
  }

  // Number
  if (/^\d+$/.test(trimmed)) {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      return { value: parseInt(trimmed, 10), remaining: null };
    }
    return { value: parseInt(trimmed.slice(0, spaceIdx), 10), remaining: trimmed.slice(spaceIdx).trim() || null };
  }

  // Boolean
  if (trimmed === 'true') {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return { value: true, remaining: null };
    return { value: true, remaining: trimmed.slice(spaceIdx).trim() || null };
  }
  if (trimmed === 'false') {
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) return { value: false, remaining: null };
    return { value: false, remaining: trimmed.slice(spaceIdx).trim() || null };
  }

  // Plain string: read until next key pattern (word followed by colon)
  const keyPattern = /\s+(\w+):/;
  const match = trimmed.match(keyPattern);
  if (match && match.index !== undefined && match.index > 0) {
    return { value: trimmed.slice(0, match.index).trim(), remaining: trimmed.slice(match.index).trim() };
  }

  return { value: trimmed, remaining: null };
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
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) { i++; continue; }

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
        i++;
        break;
      case 'enabled':
      case 'blocking':
        frontmatter[key] = value === 'true';
        i++;
        break;
      case 'cooldownPeriod':
        frontmatter[key] = parseInt(value, 10);
        i++;
        break;
      case 'watch': {
        // Parse multi-line watch array
        const { items, nextIndex } = parseArrayBlock(lines, i);
        frontmatter[key] = items;
        i = nextIndex;
        break;
      }
      default:
        i++;
        break;
    }
  }

  return { frontmatter, contentStart: match[0].length };
}

/**
 * Generate task ID from file name.
 */
function generateTaskId(fileName: string): string {
  const baseName = path.basename(fileName, '.md');
  return `schedule-${baseName}`;
}

/**
 * Parse watch trigger configuration from frontmatter.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Accepts raw frontmatter value which may be:
 * - An array of objects: [{ path: "foo", debounce: 5000 }, ...]
 * - An array of strings: ["foo", "bar"]
 * - undefined (no watch triggers)
 */
function parseWatchTriggers(raw: unknown): WatchTrigger[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;

  const triggers: WatchTrigger[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      triggers.push({ path: item });
    } else if (typeof item === 'object' && item !== null) {
      const obj = item as Record<string, unknown>;
      if (typeof obj.path === 'string') {
        triggers.push({
          path: obj.path,
          debounce: typeof obj.debounce === 'number' ? obj.debounce : undefined,
        });
      }
    }
  }

  return triggers.length > 0 ? triggers : undefined;
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
        sourceFile: filePath,
        fileMtime: stats.mtime,
        watch: parseWatchTriggers(frontmatter['watch']),
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
    if (task.watch && task.watch.length > 0) {
      frontmatter.push('watch:');
      for (const w of task.watch) {
        if (w.debounce !== undefined) {
          frontmatter.push(`  - path: "${w.path}"`);
          frontmatter.push(`    debounce: ${w.debounce}`);
        } else {
          frontmatter.push(`  - "${w.path}"`);
        }
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

/**
 * Schedule File Watcher - Hot reload for schedule files.
 *
 * Watches the schedules/ directory for changes and notifies the scheduler.
 * Supports:
 * - File added: new task
 * - File changed: update task
 * - File removed: delete task
 *
 * Uses Node.js native fs.watch with debouncing for reliability.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import type { ScheduleFileTask } from './schedule-file-scanner.js';

const logger = createLogger('ScheduleFileWatcher');

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
    await fs.promises.mkdir(this.schedulesDir, { recursive: true });

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
      this.processFileEvent(eventType, filePath, filename);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process the file event after debouncing.
   */
  private async processFileEvent(eventType: string, filePath: string, filename: string): Promise<void> {
    const taskId = this.generateTaskId(filename);

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
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse a schedule file.
   */
  private async parseFile(filePath: string): Promise<ScheduleFileTask | null> {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const stats = await fs.promises.stat(filePath);

      const frontmatter = this.parseFrontmatter(content);
      if (!frontmatter['name'] || !frontmatter['cron'] || !frontmatter['chatId']) {
        return null;
      }

      const fileName = path.basename(filePath);
      const prompt = this.extractContent(content);

      return {
        id: this.generateTaskId(fileName),
        name: frontmatter['name'] as string,
        cron: frontmatter['cron'] as string,
        chatId: frontmatter['chatId'] as string,
        prompt,
        enabled: (frontmatter['enabled'] as boolean) ?? true,
        blocking: (frontmatter['blocking'] as boolean) ?? true,
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

  /**
   * Parse YAML frontmatter.
   */
  private parseFrontmatter(content: string): Record<string, unknown> {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return {};
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
          frontmatter[key] = value.replace(/^["']|["']$/g, '');
          break;
        case 'enabled':
        case 'blocking':
          frontmatter[key] = value === 'true';
          break;
      }
    }

    return frontmatter;
  }

  /**
   * Extract content after frontmatter.
   */
  private extractContent(content: string): string {
    const frontmatterRegex = /^---\s*\n[\s\S]*?\n---\s*\n/;
    return content.replace(frontmatterRegex, '').trim();
  }

  /**
   * Generate task ID from file name.
   */
  private generateTaskId(fileName: string): string {
    const baseName = path.basename(fileName, '.md');
    return `schedule-${baseName}`;
  }
}

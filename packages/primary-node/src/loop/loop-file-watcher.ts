/**
 * LoopFileWatcher — watches the LOOP.md directory for create/change events
 * and invokes a callback which starts the loop via startFromLoopMd.
 *
 * Issue #4283 (split A of #4040): the skill writes LOOP.md via the Write tool
 * (isomorphic to issue-solver writing SCHEDULE.md); this watcher is the
 * file-based consumer bridge that starts the loop, mirroring the
 * ScheduleFileWatcher to SchedulerService pattern.
 *
 * On create/change of a LOOP.md file, the debounced callback fires with the
 * absolute file path. The caller (PrimaryNode) calls
 * getOrCreateLoopRunner().startFromLoopMd(path) (which reads the file once and
 * dedups by path), and surfaces the returned loopId to the LOOP.md chatId via
 * pushToAgent.
 *
 * Issue #4286: as a safety net for missed fs.watch events, the watcher also
 * scans `loopDir` once at start() and whenever fs.watch emits a null filename
 * (possible under high load / on some platforms — cf. ScheduleFileWatcher
 * #3860). Dedup in startFromLoopMd makes repeat scans harmless.
 */

import { existsSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createLogger, LOOP_MD_FILENAME } from '@disclaude/core';

const logger = createLogger('LoopFileWatcher');

export interface LoopFileWatcherOptions {
  /** Directory to watch recursively (e.g. workspace/.disclaude/loop). */
  loopDir: string;
  /** Called (debounced) when a LOOP.md is created or changed. */
  onLoopMd: (filePath: string) => void;
  /** Debounce window per file (default 200ms). */
  debounceMs?: number;
}

/**
 * Watches a directory tree for LOOP.md create/change events and fires a
 * debounced callback. Mirrors the ScheduleFileWatcher fs.watch + debounce
 * pattern, but simpler — no remove handling (loops are fire-and-forget;
 * stopping is via loop_stop). A startup + null-filename scan recovers any
 * LOOP.md whose create event was missed (Issue #4286).
 */
export class LoopFileWatcher {
  private readonly loopDir: string;
  private readonly onLoopMd: (filePath: string) => void;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private running = false;

  constructor(options: LoopFileWatcherOptions) {
    this.loopDir = options.loopDir;
    this.onLoopMd = options.onLoopMd;
    this.debounceMs = options.debounceMs ?? 200;
    logger.info({ loopDir: this.loopDir }, 'LoopFileWatcher initialized');
  }

  /** Start watching. Creates the directory if it does not exist. */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('LoopFileWatcher already running');
      return;
    }
    await mkdir(this.loopDir, { recursive: true });
    this.watcher = watch(
      this.loopDir,
      { persistent: true, recursive: true },
      (_eventType, filename) => {
        if (!filename) {
          // Issue #4286: fs.watch can emit a null filename under high load or
          // on certain platforms (cf. ScheduleFileWatcher #3860). Rather than
          // silently dropping the event — which would mean a LOOP.md write is
          // missed and its loop never starts — re-scan the tree. Dedup in
          // startFromLoopMd makes this safe (already-running loops are no-ops).
          logger.warn('fs.watch emitted null filename; triggering re-scan');
          this.scanOnce();
          return;
        }
        if (basename(filename) !== LOOP_MD_FILENAME) {return;}
        const filePath = join(this.loopDir, filename);
        if (!existsSync(filePath)) {return;}
        this.debouncedCall(filePath);
      },
    );
    this.watcher.on('error', (err) => {
      logger.error({ err }, 'LoopFileWatcher error');
    });
    this.running = true;
    // Issue #4286: pick up any LOOP.md that existed before the watcher started
    // or whose create event arrived before the listener was attached.
    this.scanOnce();
    logger.info({ loopDir: this.loopDir }, 'LoopFileWatcher started');
  }

  /**
   * Scan `loopDir` recursively and fire the debounced callback for every
   * LOOP.md currently on disk. Used at start() and on null-filename events as
   * a safety net for missed fs.watch events (Issue #4286).
   */
  private scanOnce(): void {
    let entries: string[] = [];
    try {
      // Node 20.9+: recursive readdir returns POSIX-style relative paths.
      entries = readdirSync(this.loopDir, { recursive: true, encoding: 'utf-8' });
    } catch (err) {
      logger.warn({ err, loopDir: this.loopDir }, 'scanOnce: failed to read loopDir');
      return;
    }
    for (const rel of entries) {
      if (basename(rel) !== LOOP_MD_FILENAME) {continue;}
      const filePath = join(this.loopDir, rel);
      if (existsSync(filePath)) {
        this.debouncedCall(filePath);
      }
    }
  }

  /** Stop watching and clear pending debounce timers. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const t of this.debounceTimers.values()) {clearTimeout(t);}
    this.debounceTimers.clear();
    this.running = false;
    logger.info('LoopFileWatcher stopped');
  }

  /** Fire the callback after the debounce window; resets on repeat events. */
  private debouncedCall(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) {clearTimeout(existing);}
    this.debounceTimers.set(
      filePath,
      setTimeout(() => {
        this.debounceTimers.delete(filePath);
        if (!existsSync(filePath)) {return;}
        try {
          this.onLoopMd(filePath);
        } catch (err) {
          logger.error({ err, filePath }, 'onLoopMd callback threw');
        }
      }, this.debounceMs),
    );
  }
}

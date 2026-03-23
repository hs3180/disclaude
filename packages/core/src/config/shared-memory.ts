/**
 * Structured Shared Memory Store (Issue #1371)
 *
 * A JSON-based shared memory system that replaces the flat KEY=VALUE
 * `.runtime-env` file with support for:
 * - Namespaced structured data (objects, arrays, primitives)
 * - Type-safe typed access API
 * - Change notification via fs.watch
 * - Atomic writes (write-to-temp-then-rename)
 * - TTL/expiration enforcement
 * - Backward compatibility with .runtime-env
 *
 * Storage format: `{workspace}/.shared-memory.json`
 *
 * Why file-based? Same rationale as .runtime-env — Agent runs in an SDK
 * subprocess, so in-memory singletons from the main process are inaccessible.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SharedMemory');

const FILENAME = '.shared-memory.json';
const VERSION = 1;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Options for set() operations */
export interface SetOptions {
  /** Auto-expire after N milliseconds */
  ttl?: number;
  /** Deep merge instead of replace */
  merge?: boolean;
}

/** Internal entry with optional TTL metadata */
interface EntryWithMeta {
  _value: unknown;
  _expiresAt?: number; // Unix timestamp ms
  _updatedAt: number;
  _updatedBy: string;
}

/** The full shared memory file structure */
export interface SharedMemoryData {
  _meta: {
    version: number;
    lastModified: string;
    lastWriter: string;
  };
  namespaces: Record<string, Record<string, EntryWithMeta>>;
}

/** Callback type for watch notifications */
export type WatchCallback = (key: string, value: unknown) => void;

/** Unwatch function returned by watch() */
export type UnwatchFn = () => void;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get a default writer identifier */
function getWriterId(): string {
  return `pid-${process.pid}`;
}

/** Check if an entry has expired */
function isExpired(entry: EntryWithMeta): boolean {
  if (!entry._expiresAt) return false;
  return Date.now() > entry._expiresAt;
}

/** Atomic write: write to temp file then rename */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

/** Deep merge two objects */
function deepMerge(target: unknown, source: unknown): unknown {
  if (typeof source !== 'object' || source === null) return source;
  if (Array.isArray(source)) return source;

  const result = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source as Record<string, unknown>)) {
    const sourceVal = (source as Record<string, unknown>)[key];
    const targetVal = (target as Record<string, unknown>)[key];

    if (
      typeof sourceVal === 'object' &&
      sourceVal !== null &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

// ─── SharedMemory Class ────────────────────────────────────────────────────

export class SharedMemory {
  private readonly filePath: string;
  private readonly writerId: string;
  private data: SharedMemoryData;
  private watchers: Map<string, Set<WatchCallback>>;
  private fsWatcher: fs.FSWatcher | null = null;
  private dirty: boolean = false;

  constructor(workspaceDir: string) {
    this.filePath = path.join(workspaceDir, FILENAME);
    this.writerId = getWriterId();
    this.watchers = new Map();
    this.data = this.readFromDisk();
  }

  // ─── Read Operations ───────────────────────────────────────────────────

  /**
   * Get a value from a namespace.
   * Returns undefined if namespace/key doesn't exist or entry has expired.
   */
  get<T = unknown>(namespace: string, key: string): T | undefined {
    const entry = this.data.namespaces[namespace]?.[key];
    if (!entry) return undefined;

    if (isExpired(entry)) {
      // Clean up expired entry lazily
      this.delete(namespace, key);
      return undefined;
    }

    return entry._value as T;
  }

  /**
   * Get all entries in a namespace.
   * Automatically filters out expired entries.
   */
  getAll(namespace: string): Record<string, unknown> {
    const ns = this.data.namespaces[namespace];
    if (!ns) return {};

    const result: Record<string, unknown> = {};
    let hasExpired = false;

    for (const [key, entry] of Object.entries(ns)) {
      if (isExpired(entry)) {
        hasExpired = true;
      } else {
        result[key] = entry._value;
      }
    }

    // Lazy cleanup of expired entries
    if (hasExpired) {
      this.cleanExpired(namespace);
    }

    return result;
  }

  /**
   * Get all namespaces and their entries.
   * Returns a plain object (no metadata).
   */
  getSnapshot(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [ns] of Object.entries(this.data.namespaces)) {
      result[ns] = this.getAll(ns);
    }
    return result;
  }

  /**
   * Check if a key exists in a namespace (and is not expired).
   */
  has(namespace: string, key: string): boolean {
    return this.get(namespace, key) !== undefined;
  }

  // ─── Write Operations ──────────────────────────────────────────────────

  /**
   * Set a value in a namespace.
   *
   * @param namespace - The namespace (e.g., 'auth', 'task', 'context')
   * @param key - The key within the namespace
   * @param value - The value to store (any JSON-serializable value)
   * @param options - Optional settings (TTL, merge)
   */
  set<T = unknown>(namespace: string, key: string, value: T, options?: SetOptions): void {
    if (!this.data.namespaces[namespace]) {
      this.data.namespaces[namespace] = {};
    }

    const existingEntry = this.data.namespaces[namespace][key];

    // If merge is requested and both values are objects, deep merge
    let finalValue: unknown = value;
    if (options?.merge && existingEntry && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      finalValue = deepMerge(existingEntry._value, value);
    }

    const entry: EntryWithMeta = {
      _value: finalValue,
      _updatedAt: Date.now(),
      _updatedBy: this.writerId,
    };

    if (options?.ttl && options.ttl > 0) {
      entry._expiresAt = Date.now() + options.ttl;
    }

    this.data.namespaces[namespace][key] = entry;
    this.markDirty();

    logger.debug({ namespace, key, ttl: options?.ttl, merge: options?.merge }, 'Set shared memory entry');
  }

  /**
   * Delete a key from a namespace.
   */
  delete(namespace: string, key: string): void {
    const ns = this.data.namespaces[namespace];
    if (!ns || !(key in ns)) return;

    delete ns[key];

    // Clean up empty namespace
    if (Object.keys(ns).length === 0) {
      delete this.data.namespaces[namespace];
    }

    this.markDirty();
    logger.debug({ namespace, key }, 'Deleted shared memory entry');
  }

  /**
   * Delete an entire namespace and all its keys.
   */
  deleteNamespace(namespace: string): void {
    if (!this.data.namespaces[namespace]) return;

    delete this.data.namespaces[namespace];
    this.markDirty();
    logger.debug({ namespace }, 'Deleted shared memory namespace');
  }

  /**
   * Remove all expired entries across all namespaces.
   */
  cleanExpired(namespace?: string): number {
    let cleaned = 0;

    const namespaces = namespace
      ? { [namespace]: this.data.namespaces[namespace] }
      : this.data.namespaces;

    for (const [ns, entries] of Object.entries(namespaces)) {
      if (!entries) continue;

      for (const key of Object.keys(entries)) {
        if (isExpired(entries[key])) {
          delete entries[key];
          cleaned++;
        }
      }

      // Clean up empty namespace
      if (Object.keys(entries).length === 0) {
        delete this.data.namespaces[ns];
      }
    }

    if (cleaned > 0) {
      this.markDirty();
      logger.debug({ cleaned, namespace }, 'Cleaned expired shared memory entries');
    }

    return cleaned;
  }

  // ─── Watch Operations ──────────────────────────────────────────────────

  /**
   * Watch a namespace for changes.
   * Uses fs.watch for file system events and notifies on changes
   * to any key within the namespace.
   *
   * @param namespace - The namespace to watch
   * @param callback - Called with (key, value) when a change is detected
   * @returns Unwatch function
   */
  watch(namespace: string, callback: WatchCallback): UnwatchFn {
    if (!this.watchers.has(namespace)) {
      this.watchers.set(namespace, new Set());
    }
    this.watchers.get(namespace)!.add(callback);

    // Start fs.watch if not already watching
    this.ensureWatching();

    return () => {
      const callbacks = this.watchers.get(namespace);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.watchers.delete(namespace);
        }
      }
      // Stop fs.watch if no watchers remain
      if (this.watchers.size === 0) {
        this.stopWatching();
      }
    };
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  /**
   * Persist current state to disk (atomic write).
   * Called automatically after modifications when flush() is invoked.
   */
  flush(): void {
    if (!this.dirty) return;

    this.data._meta.lastModified = new Date().toISOString();
    this.data._meta.lastWriter = this.writerId;

    const content = JSON.stringify(this.data, null, 2);
    atomicWrite(this.filePath, content);

    this.dirty = false;
    logger.debug({ path: this.filePath }, 'Flushed shared memory to disk');
  }

  /**
   * Reload state from disk.
   * Useful for picking up changes made by other processes.
   */
  reload(): void {
    const previous = this.data;
    this.data = this.readFromDisk();

    // Notify watchers of changes
    this.notifyWatchers(previous, this.data);
  }

  /**
   * Dispose of resources (stop fs.watch, flush pending changes).
   */
  dispose(): void {
    this.flush();
    this.stopWatching();
    this.watchers.clear();
  }

  // ─── Backward Compatibility ────────────────────────────────────────────

  /**
   * Migrate all entries from .runtime-env to shared memory.
   * Entries are placed in the 'runtime-env' namespace.
   *
   * @param workspaceDir - The workspace directory
   * @returns Number of entries migrated
   */
  migrateFromRuntimeEnv(workspaceDir: string): number {
    const runtimeEnvPath = path.join(workspaceDir, '.runtime-env');

    try {
      const content = fs.readFileSync(runtimeEnvPath, 'utf-8');
      let count = 0;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex).trim();
          const value = trimmed.slice(eqIndex + 1).trim();
          // Only set if not already present in shared memory
          if (!this.has('runtime-env', key)) {
            this.set('runtime-env', key, value);
            count++;
          }
        }
      }

      if (count > 0) {
        this.flush();
        logger.info({ count }, 'Migrated entries from .runtime-env to shared memory');
      }

      return count;
    } catch {
      return 0;
    }
  }

  /**
   * Export shared memory entries as a flat KEY=VALUE format
   * compatible with .runtime-env. Useful for backward compatibility.
   *
   * @param namespace - The namespace to export (default: 'runtime-env')
   * @returns Flat Record<string, string>
   */
  exportAsEnvVars(namespace = 'runtime-env'): Record<string, string> {
    const entries = this.getAll(namespace);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries)) {
      result[key] = String(value);
    }
    return result;
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  private markDirty(): void {
    this.dirty = true;
  }

  private readFromDisk(): SharedMemoryData {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as SharedMemoryData;

      // Validate basic structure
      if (!parsed._meta || !parsed.namespaces) {
        logger.warn('Invalid shared memory file structure, creating new');
        return this.createEmptyData();
      }

      return parsed;
    } catch (err) {
      // File doesn't exist or is invalid — start fresh
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'Failed to read shared memory file, creating new');
      }
      return this.createEmptyData();
    }
  }

  private createEmptyData(): SharedMemoryData {
    return {
      _meta: {
        version: VERSION,
        lastModified: new Date().toISOString(),
        lastWriter: this.writerId,
      },
      namespaces: {},
    };
  }

  private ensureWatching(): void {
    if (this.fsWatcher) return;

    try {
      this.fsWatcher = fs.watch(
        this.filePath,
        { persistent: false },
        (eventType) => {
          if (eventType === 'change') {
            this.reload();
          }
        }
      );

      // Handle watcher errors gracefully
      this.fsWatcher.on('error', (err) => {
        logger.warn({ err }, 'fs.watch error on shared memory file');
        this.fsWatcher = null;
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to start fs.watch on shared memory file');
    }
  }

  private stopWatching(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private notifyWatchers(previous: SharedMemoryData, current: SharedMemoryData): void {
    // Collect all namespaces that are being watched
    for (const [namespace, callbacks] of this.watchers) {
      const prevNs = previous.namespaces[namespace] || {};
      const currNs = current.namespaces[namespace] || {};
      const allKeys = new Set([...Object.keys(prevNs), ...Object.keys(currNs)]);

      for (const key of allKeys) {
        const prevEntry = prevNs[key];
        const currEntry = currNs[key];

        // Skip if both undefined (no change)
        if (!prevEntry && !currEntry) continue;

        // Determine the current value
        let currValue: unknown;
        if (currEntry && !isExpired(currEntry)) {
          currValue = currEntry._value;
        } else {
          currValue = undefined;
        }

        // Determine the previous value
        let prevValue: unknown;
        if (prevEntry && !isExpired(prevEntry)) {
          prevValue = prevEntry._value;
        } else {
          prevValue = undefined;
        }

        // Only notify if value actually changed
        if (JSON.stringify(prevValue) !== JSON.stringify(currValue)) {
          for (const cb of callbacks) {
            try {
              cb(key, currValue);
            } catch (err) {
              logger.warn({ err, namespace, key }, 'Watch callback error');
            }
          }
        }
      }
    }
  }
}

// ─── Convenience Factory ────────────────────────────────────────────────────

/**
 * Create a new SharedMemory instance for a workspace.
 *
 * @param workspaceDir - The workspace directory
 * @returns SharedMemory instance
 */
export function createSharedMemory(workspaceDir: string): SharedMemory {
  return new SharedMemory(workspaceDir);
}

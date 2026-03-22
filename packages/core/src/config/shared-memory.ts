/**
 * Structured Shared Memory System (Issue #1371)
 *
 * Replaces the flat KEY=VALUE .runtime-env file with a JSON-based
 * shared memory store that supports:
 * - Namespaced keys
 * - Structured data (objects, arrays)
 * - TTL/expiration
 * - Change notification via fs.watch
 * - Atomic writes
 *
 * Phase 1: Coexists with .runtime-env for backward compatibility.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import type {
  SetOptions,
  SharedMemoryEntry,
  SharedMemoryStorage,
  WatchCallback,
  Unwatch,
} from './shared-memory-types.js';

const logger = createLogger('SharedMemory');

const FILENAME = '.shared-memory.json';
const SCHEMA_VERSION = 1;

/**
 * Structured shared memory for inter-agent communication.
 *
 * Usage:
 * ```typescript
 * const memory = new SharedMemory(workspaceDir);
 *
 * // Set a value
 * memory.set('auth', 'github', { token: 'ghs_xxx', expiresAt: '...' });
 *
 * // Get a value
 * const github = memory.get<{ token: string }>('auth', 'github');
 *
 * // Watch for changes
 * const unwatch = memory.watch('auth', (key, value) => {
 *   console.log(`${key} changed:`, value);
 * });
 * ```
 */
export class SharedMemory {
  private readonly filePath: string;
  private readonly watchers: Map<string, Set<WatchCallback>> = new Map();
  private fsWatcher: fs.FSWatcher | null = null;
  private cache: SharedMemoryStorage | null = null;
  private cacheTime: number = 0;
  private readonly cacheTTL: number = 100; // 100ms cache to reduce file reads

  constructor(
    workspaceDir: string,
    private readonly writerId: string = `process-${process.pid}`
  ) {
    this.filePath = path.join(workspaceDir, FILENAME);
  }

  /**
   * Get a value from shared memory.
   *
   * @param namespace - The namespace (e.g., 'auth', 'task')
   * @param key - The key within the namespace
   * @returns The value or undefined if not found or expired
   */
  get<T = unknown>(namespace: string, key: string): T | undefined {
    const storage = this.readStorage();
    const entry = storage.namespaces[namespace]?.[key];

    if (!entry) {
      return undefined;
    }

    // Check expiration
    if (this.isExpired(entry)) {
      // Clean up expired entry
      this.delete(namespace, key);
      return undefined;
    }

    return entry.value as T;
  }

  /**
   * Set a value in shared memory.
   *
   * @param namespace - The namespace (e.g., 'auth', 'task')
   * @param key - The key within the namespace
   * @param value - The value to store
   * @param options - Optional settings (ttl, merge)
   */
  set<T>(namespace: string, key: string, value: T, options?: SetOptions): void {
    const storage = this.readStorage();
    const now = new Date().toISOString();

    // Ensure namespace exists
    if (!storage.namespaces[namespace]) {
      storage.namespaces[namespace] = {};
    }

    const existing = storage.namespaces[namespace][key];
    let finalValue = value;

    // Handle merge option
    if (options?.merge && existing && typeof existing.value === 'object' && typeof value === 'object') {
      finalValue = { ...existing.value as object, ...value as object } as T;
    }

    // Build entry
    const entry: SharedMemoryEntry<T> = {
      value: finalValue,
      meta: {
        createdAt: existing?.meta.createdAt || now,
        modifiedAt: now,
        ttl: options?.ttl,
        expiresAt: options?.ttl
          ? new Date(Date.now() + options.ttl).toISOString()
          : undefined,
        writer: this.writerId,
      },
    };

    storage.namespaces[namespace][key] = entry;
    this.writeStorage(storage);

    logger.debug({ namespace, key, ttl: options?.ttl }, 'Set shared memory entry');
  }

  /**
   * Delete a value from shared memory.
   *
   * @param namespace - The namespace
   * @param key - The key to delete
   */
  delete(namespace: string, key: string): void {
    const storage = this.readStorage();

    if (!storage.namespaces[namespace]?.[key]) {
      return;
    }

    delete storage.namespaces[namespace][key];

    // Clean up empty namespace
    if (Object.keys(storage.namespaces[namespace]).length === 0) {
      delete storage.namespaces[namespace];
    }

    this.writeStorage(storage);
    logger.debug({ namespace, key }, 'Deleted shared memory entry');
  }

  /**
   * Get all entries in a namespace.
   *
   * @param namespace - The namespace
   * @returns Record of key-value pairs (without metadata)
   */
  getAll<T = unknown>(namespace: string): Record<string, T> {
    const storage = this.readStorage();
    const ns = storage.namespaces[namespace];
    const result: Record<string, T> = {};

    if (!ns) {
      return result;
    }

    for (const [key, entry] of Object.entries(ns)) {
      if (entry && !this.isExpired(entry)) {
        result[key] = entry.value as T;
      }
    }

    return result;
  }

  /**
   * Get all namespaces.
   *
   * @returns Array of namespace names
   */
  getNamespaces(): string[] {
    const storage = this.readStorage();
    return Object.keys(storage.namespaces);
  }

  /**
   * Check if a namespace exists.
   *
   * @param namespace - The namespace to check
   * @returns true if namespace has entries
   */
  hasNamespace(namespace: string): boolean {
    const storage = this.readStorage();
    return !!storage.namespaces[namespace] &&
           Object.keys(storage.namespaces[namespace]).length > 0;
  }

  /**
   * Watch for changes in a namespace.
   *
   * Note: fs.watch works across processes on most systems, but behavior
   * can vary. For reliable cross-process notification, consider polling.
   *
   * @param namespace - The namespace to watch (or '*' for all)
   * @param callback - Function called on changes
   * @returns Unwatch function
   */
  watch(namespace: string, callback: WatchCallback): Unwatch {
    const key = namespace;

    if (!this.watchers.has(key)) {
      this.watchers.set(key, new Set());
    }

    this.watchers.get(key)!.add(callback);

    // Start fs.watch if not already running
    this.startWatcher();

    // Return unwatch function
    return () => {
      const watchers = this.watchers.get(key);
      if (watchers) {
        watchers.delete(callback);
        if (watchers.size === 0) {
          this.watchers.delete(key);
        }
      }

      // Stop fs.watch if no more watchers
      if (this.watchers.size === 0) {
        this.stopWatcher();
      }
    };
  }

  /**
   * Clear all entries in a namespace or all namespaces.
   *
   * @param namespace - Optional namespace to clear (all if not specified)
   */
  clear(namespace?: string): void {
    if (namespace) {
      const storage = this.readStorage();
      delete storage.namespaces[namespace];
      this.writeStorage(storage);
      logger.debug({ namespace }, 'Cleared namespace');
    } else {
      this.writeStorage(this.createEmptyStorage());
      logger.debug('Cleared all shared memory');
    }
  }

  /**
   * Clean up expired entries across all namespaces.
   *
   * @returns Number of entries removed
   */
  cleanup(): number {
    const storage = this.readStorage();
    let removed = 0;

    for (const [ns, entries] of Object.entries(storage.namespaces)) {
      for (const [key, entry] of Object.entries(entries || {})) {
        if (entry && this.isExpired(entry)) {
          delete storage.namespaces[ns][key];
          removed++;
        }
      }

      // Clean up empty namespace
      if (Object.keys(storage.namespaces[ns]).length === 0) {
        delete storage.namespaces[ns];
      }
    }

    if (removed > 0) {
      this.writeStorage(storage);
      logger.debug({ removed }, 'Cleaned up expired entries');
    }

    return removed;
  }

  /**
   * Export current state as a flat env object (for backward compatibility).
   * Only exports string values suitable for environment variables.
   *
   * @returns Record of string key-value pairs
   */
  toEnv(): Record<string, string> {
    const storage = this.readStorage();
    const env: Record<string, string> = {};

    // Export auth tokens as env vars
    const auth = storage.namespaces.auth;
    if (auth?.github?.value && typeof auth.github.value === 'object') {
      const github = auth.github.value as { token?: string; expiresAt?: string };
      if (github.token) {
        env.GH_TOKEN = github.token;
      }
      if (github.expiresAt) {
        env.GH_TOKEN_EXPIRES_AT = github.expiresAt;
      }
    }

    return env;
  }

  // --- Private methods ---

  private createEmptyStorage(): SharedMemoryStorage {
    return {
      namespaces: {},
      _meta: {
        version: SCHEMA_VERSION,
        lastModified: new Date().toISOString(),
        lastWriter: this.writerId,
      },
    };
  }

  private readStorage(): SharedMemoryStorage {
    // Check cache
    const now = Date.now();
    if (this.cache && (now - this.cacheTime) < this.cacheTTL) {
      return this.cache;
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        const empty = this.createEmptyStorage();
        this.cache = empty;
        this.cacheTime = now;
        return empty;
      }

      const content = fs.readFileSync(this.filePath, 'utf-8');
      const storage = JSON.parse(content) as SharedMemoryStorage;

      // Validate schema version
      if (storage._meta?.version !== SCHEMA_VERSION) {
        logger.warn(
          { version: storage._meta?.version, expected: SCHEMA_VERSION },
          'Shared memory schema version mismatch, resetting'
        );
        const empty = this.createEmptyStorage();
        this.cache = empty;
        this.cacheTime = now;
        return empty;
      }

      this.cache = storage;
      this.cacheTime = now;
      return storage;
    } catch (err) {
      logger.warn({ err }, 'Failed to read shared memory, returning empty');
      const empty = this.createEmptyStorage();
      this.cache = empty;
      this.cacheTime = now;
      return empty;
    }
  }

  private writeStorage(storage: SharedMemoryStorage): void {
    // Invalidate cache
    this.cache = null;

    // Update metadata
    storage._meta.lastModified = new Date().toISOString();
    storage._meta.lastWriter = this.writerId;

    // Atomic write: write to temp file, then rename
    const tempPath = `${this.filePath}.tmp.${process.pid}`;
    const content = JSON.stringify(storage, null, 2);

    try {
      fs.writeFileSync(tempPath, content, 'utf-8');
      fs.renameSync(tempPath, this.filePath);
    } catch (err) {
      // Clean up temp file on error
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  private isExpired(entry: SharedMemoryEntry): boolean {
    if (!entry.meta.expiresAt) {
      return false;
    }
    return new Date(entry.meta.expiresAt) < new Date();
  }

  private startWatcher(): void {
    if (this.fsWatcher) {
      return;
    }

    try {
      // Ensure file exists for watching
      if (!fs.existsSync(this.filePath)) {
        this.writeStorage(this.createEmptyStorage());
      }

      this.fsWatcher = fs.watch(
        this.filePath,
        (eventType) => {
          if (eventType === 'change') {
            // Invalidate cache on external change
            this.cache = null;
            this.notifyWatchers();
          }
        }
      );

      this.fsWatcher.on('error', (err) => {
        logger.warn({ err }, 'Shared memory watcher error');
        this.stopWatcher();
      });
    } catch (err) {
      logger.warn({ err }, 'Failed to start shared memory watcher');
    }
  }

  private stopWatcher(): void {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
  }

  private notifyWatchers(): void {
    const storage = this.readStorage();

    // Notify specific namespace watchers
    for (const [ns, callbacks] of this.watchers) {
      if (ns === '*') {
        // Notify for all namespaces
        for (const [namespace, entries] of Object.entries(storage.namespaces)) {
          for (const [key, entry] of Object.entries(entries || {})) {
            if (entry) {
              for (const cb of callbacks) {
                try {
                  cb(key, entry.value, namespace);
                } catch (err) {
                  logger.warn({ err, namespace, key }, 'Watcher callback error');
                }
              }
            }
          }
        }
      } else {
        // Notify for specific namespace
        const entries = storage.namespaces[ns];
        if (entries) {
          for (const [key, entry] of Object.entries(entries)) {
            if (entry) {
              for (const cb of callbacks) {
                try {
                  cb(key, entry.value, ns);
                } catch (err) {
                  logger.warn({ err, namespace: ns, key }, 'Watcher callback error');
                }
              }
            }
          }
        }
      }
    }
  }
}

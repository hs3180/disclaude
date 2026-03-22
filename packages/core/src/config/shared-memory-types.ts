/**
 * SharedMemory Type Definitions (Issue #1371)
 *
 * Defines types for the structured shared memory system that replaces
 * the flat .runtime-env file with namespaced, typed storage.
 */

/**
 * Options for setting a value in shared memory.
 */
export interface SetOptions {
  /** Time-to-live in milliseconds. Entry auto-expires after this duration. */
  ttl?: number;
  /** Deep merge with existing value instead of replacing. */
  merge?: boolean;
}

/**
 * Metadata for a shared memory entry.
 */
export interface EntryMeta {
  /** Timestamp when the entry was created (ISO 8601) */
  createdAt: string;
  /** Timestamp when the entry was last modified (ISO 8601) */
  modifiedAt: string;
  /** TTL in milliseconds (optional) */
  ttl?: number;
  /** Timestamp when the entry expires (ISO 8601, optional) */
  expiresAt?: string;
  /** Process that wrote the entry */
  writer?: string;
}

/**
 * A single entry in shared memory with metadata.
 */
export interface SharedMemoryEntry<T = unknown> {
  /** The stored value */
  value: T;
  /** Entry metadata */
  meta: EntryMeta;
}

/**
 * A namespace containing multiple entries.
 */
export interface SharedMemoryNamespace {
  /** Namespace entries keyed by their keys */
  [key: string]: SharedMemoryEntry | undefined;
}

/**
 * Internal storage structure for the shared memory file.
 */
export interface SharedMemoryStorage {
  /** Namespaced entries */
  namespaces: Record<string, SharedMemoryNamespace>;
  /** File metadata */
  _meta: {
    /** Schema version */
    version: number;
    /** Last modification timestamp (ISO 8601) */
    lastModified: string;
    /** Process that last modified the file */
    lastWriter?: string;
  };
}

/**
 * Callback function type for watch notifications.
 */
export type WatchCallback<T = unknown> = (
  key: string,
  value: T | undefined,
  namespace: string
) => void;

/**
 * Unwatch function returned by watch() to stop watching.
 */
export type Unwatch = () => void;

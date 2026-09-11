/**
 * Platform Adapter Interfaces.
 *
 * These interfaces define platform-agnostic contracts for message handling
 * and file operations. Each platform (Feishu, REST, etc.) should implement
 * these interfaces.
 *
 * Architecture:
 * ```
 * Channel (BaseChannel)
 *     ├── IMessageSender (adapter)
 *     └── IFileHandler (adapter)
 * ```
 *
 * Migrated to @disclaude/core (Issue #1040)
 */
export {};

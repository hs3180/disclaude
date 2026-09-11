/**
 * Platform Adapter Interfaces.
 *
 * These interfaces define platform-agnostic contracts for message handling
 * and file operations. Each platform (Feishu, REST, Ruliu, etc.) should implement
 * these interfaces.
 *
 * Architecture:
 * ```
 * Channel (BaseChannel)
 *     ├── IMessageSender (adapter)
 *     └── IFileHandler (adapter)
 * ```
 */
export {};

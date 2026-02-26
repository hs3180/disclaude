/**
 * Feishu Platform Adapter.
 *
 * This module will contain the Feishu-specific platform implementations:
 * - FeishuPlatformAdapter: Main adapter combining sender + file handler
 * - FeishuApiClient: Feishu SDK wrapper
 * - Card builders: Interactive card construction
 *
 * Migration Status:
 * - [ ] Merge feishu/message-sender.ts + sender.ts + feishu-message-sender.ts
 * - [ ] Merge feishu/file-handler.ts + feishu-file-handler.ts
 * - [ ] Move card-builders from channels/platforms/feishu/
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 */

// Re-export from existing location for backward compatibility
export * from '../../channels/platforms/feishu/index.js';

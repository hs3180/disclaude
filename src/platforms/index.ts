/**
 * Platforms Module.
 *
 * Unified platform adapter system supporting multiple messaging platforms.
 *
 * Structure:
 * - base/: Platform-agnostic interfaces (IPlatformAdapter, IMessageSender, etc.)
 * - feishu/: Feishu/Lark platform implementation
 * - ruliu/: Ruliu (如流) platform implementation
 * - (future) rest/: REST API platform implementation
 * - (future) wecom/: WeChat Work platform implementation
 * - (future) dingtalk/: DingTalk platform implementation
 *
 * @see Issue #194 - Refactor: 统一文件传输系统架构
 * @see Issue #725 - feat: 如流(Ruliu)平台适配器集成
 */

// Base interfaces
export * from './base/index.js';

// Platform implementations
export * from './feishu/index.js';
export * from './ruliu/index.js';

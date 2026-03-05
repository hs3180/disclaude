/**
 * Command System - DI-based command registration and discovery.
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #696: 拆分 builtin-commands.ts
 */

// Types
export * from './types.js';

// Registry
export * from './command-registry.js';

// Commands by category
export * from './session-commands.js';
export * from './node-commands.js';
export * from './group-commands.js';
export * from './debug-commands.js';
export * from './schedule-command.js';
export * from './task-command.js';

// Unified exports and registration
export * from './builtin-commands.js';

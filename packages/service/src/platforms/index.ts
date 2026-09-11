/**
 * Platform adapters for @disclaude/service.
 *
 * This module contains platform-specific implementations for
 * different messaging platforms (Feishu, Ruliu, etc.).
 *
 * @see Issue #1040 - Separate disclaude service code to @disclaude/service
 */

// Feishu platform
export * from './feishu/index.js';

// Ruliu platform
export * from './ruliu/index.js';

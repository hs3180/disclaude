/**
 * Routers module - Routes messages between nodes and channels.
 *
 * Issue #1040: Migrated to @disclaude/primary-node
 */

// Re-export types from @disclaude/core
export type {
  CardActionMessage,
} from '@disclaude/core';

export { CardActionRouter, type CardActionRouterConfig, type ChatContextResult, type RouteCardActionResult } from './card-action-router.js';

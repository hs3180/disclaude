/**
 * Feishu platform module for @disclaude/service.
 *
 * This module contains Feishu-specific platform adapters and services.
 *
 * @see Issue #1040 - Separate disclaude service code to @disclaude/service
 */
// Welcome service
export { WelcomeService, initWelcomeService, getWelcomeService, resetWelcomeService, } from './welcome-service.js';
// Feishu client factory
export { createFeishuClient, } from './create-feishu-client.js';
// Interaction Manager
export { InteractionManager, } from './interaction-manager.js';
// Card Builders
export { buildTextContent, buildPostContent, buildSimplePostContent, } from './card-builders/content-builder.js';
export { buildButton, buildMenu, buildDiv, buildMarkdown, buildDivider, buildActionGroup, buildNote, buildColumnSet, buildCard, buildConfirmCard, buildSelectionCard, } from './card-builders/interactive-card-builder.js';
export { extractCardTextContent, extractFullCardContent } from './card-builders/card-text-extractor.js';

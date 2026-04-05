/**
 * Knowledge base module.
 *
 * Provides project-scoped knowledge base and instructions management,
 * similar to Claude Projects functionality.
 *
 * @module knowledge
 *
 * Usage:
 * ```typescript
 * import { createProjectManager } from '../knowledge/index.js';
 *
 * const manager = createProjectManager(config.projects, workspaceDir);
 * if (manager) {
 *   const section = await manager.getKnowledgeSection(chatId);
 *   // Inject section into agent prompt
 * }
 * ```
 */

export * from './types.js';
export { loadProjectKnowledge, buildKnowledgeSection } from './loader.js';
export { ProjectManager, createProjectManager } from './project-manager.js';

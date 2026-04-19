/**
 * ProjectManager module — unified per-chatId Agent context switching.
 *
 * @see docs/proposals/unified-project-context.md
 * @see Issue #1916
 */

export type {
  CwdProvider,
  InstanceInfo,
  PersistedInstance,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
  ProjectsPersistData,
} from './types.js';

export {
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
} from './template-discovery.js';

export type {
  DiscoveryResult,
  DiscoveryError,
  DiscoveryOptions,
} from './template-discovery.js';

export { ProjectManager } from './project-manager.js';

// Taste module — per-project user preference management (Issue #2335)
export type {
  TasteCategory,
  TasteData,
  TasteManagerOptions,
  TasteResult,
  TasteRule,
  TasteSource,
} from './taste-types.js';

export { TasteManager } from './taste-manager.js';

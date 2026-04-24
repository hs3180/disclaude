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
  // Taste types (Issue #2335)
  TasteSource,
  TasteCategory,
  TasteRule,
  TasteData,
  TasteManagerOptions,
  AddTasteInput,
  UpdateTasteInput,
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

// TasteManager (Issue #2335)
export { TasteManager } from './taste-manager.js';

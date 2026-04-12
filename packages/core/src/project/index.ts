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

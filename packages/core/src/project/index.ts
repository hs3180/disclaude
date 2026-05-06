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

// Project state persistence (Issue #3335)
export type {
  IssueTriageStatus,
  ProjectIssueState,
  PrReviewStatus,
  ProjectPrState,
  ProjectSyncState,
  ProjectState,
} from './project-state.js';

export {
  PROJECT_STATE_FILENAME,
  resolveStatePath,
  createEmptyState,
  readProjectState,
  writeProjectState,
  updateProjectState,
  isValidProjectState,
  formatStateSummary,
} from './project-state.js';

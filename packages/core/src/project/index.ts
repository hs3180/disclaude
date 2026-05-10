/**
 * ProjectManager module — unified per-chatId Agent context switching.
 *
 * @see docs/proposals/unified-project-context.md
 * @see Issue #1916
 */

export type {
  CwdProvider,
  InstanceInfo,
  IssueTriageStatus,
  PersistedInstance,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectState,
  ProjectStateIssueEntry,
  ProjectStatePrEntry,
  ProjectStateSync,
  ProjectTemplate,
  ProjectTemplatesConfig,
  ProjectsPersistData,
  PrReviewStatus,
} from './types.js';

export {
  createDefaultState,
  getStateDir,
  getStateFilePath,
  isValidIssueEntry,
  isValidProjectState,
  isValidPrEntry,
  readProjectState,
  updateSyncTimestamp,
  upsertIssue,
  upsertPr,
  writeProjectState,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
  STATE_VERSION,
} from './project-state.js';

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

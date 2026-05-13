/**
 * ProjectManager module — simplified per-chatId working directory binding.
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (parent — unified ProjectContext system)
 */

export type {
  CwdProvider,
  IssueTriageStatus,
  ProjectConfig,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectState,
  ProjectStateIssueEntry,
  ProjectStatePrEntry,
  ProjectStateSync,
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

export { ProjectManager } from './project-manager.js';

// ProjectConfigStore (Issue #3329 Phase 2)
export { ProjectConfigStore } from './project-config-store.js';

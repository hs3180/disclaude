/**
 * ProjectManager integration — wiring to Config and creating CwdProvider.
 *
 * This module bridges the project module with the config system,
 * providing a factory function that creates a fully-configured CwdProvider
 * for injection into the Agent/Pilot layer.
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 * @see Issue #1916 (parent)
 */

import { ProjectManager, type FilesystemOps } from './project-manager.js';
import type { CwdProvider, ProjectTemplatesConfig } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProjectIntegration');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Factory Functions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Options for creating a CwdProvider from config.
 */
export interface CreateCwdProviderOptions {
  /** Workspace root directory */
  workspaceDir: string;
  /** Package directory (contains templates/) */
  packageDir: string;
  /** Template configuration (from disclaude.config.yaml projectTemplates) */
  templatesConfig?: ProjectTemplatesConfig;
  /**
   * Optional filesystem adapter for testing.
   * Defaults to real `node:fs` in production.
   */
  fsOps?: FilesystemOps;
}

/**
 * Result of createCwdProviderFromConfig — includes the provider and the
 * underlying ProjectManager for lifecycle management.
 */
export interface CwdProviderResult {
  /** The CwdProvider function for injection into Agent/Pilot */
  provider: CwdProvider;
  /** The underlying ProjectManager instance for advanced operations */
  manager: ProjectManager;
}

/**
 * Create a CwdProvider wired to config-driven ProjectManager.
 *
 * This is the main integration entry point for Sub-Issue E (#2227).
 * It creates a ProjectManager with config-loaded templates and returns
 * both the CwdProvider and the manager instance.
 *
 * Usage:
 * ```typescript
 * const { provider, manager } = createCwdProviderFromConfig({
 *   workspaceDir: Config.getWorkspaceDir(),
 *   packageDir: Config.getAgentsDir(),
 *   templatesConfig: Config.getProjectTemplatesConfig(),
 * });
 *
 * // Inject provider into Agent
 * agent.setCwdProvider(provider);
 *
 * // Use manager for admin operations
 * manager.create(chatId, 'research', 'my-project');
 * ```
 *
 * @param options - Configuration for the ProjectManager
 * @returns Object containing the CwdProvider and ProjectManager
 */
export function createCwdProviderFromConfig(
  options: CreateCwdProviderOptions,
): CwdProviderResult {
  const { workspaceDir, packageDir, templatesConfig = {}, fsOps } = options;

  const manager = new ProjectManager({
    workspaceDir,
    packageDir,
    templatesConfig,
  }, fsOps);

  // Initialize with config-provided templates
  manager.init(templatesConfig);

  const templateNames = Object.keys(templatesConfig);
  if (templateNames.length > 0) {
    logger.info(
      { templates: templateNames, workspaceDir },
      'ProjectManager initialized with config templates',
    );
  } else {
    logger.debug({ workspaceDir }, 'ProjectManager initialized (no templates configured)');
  }

  // createCwdProvider() returns a closure that:
  // - Returns the workingDir for the chatId's active project
  // - Returns undefined for "default" project → SDK falls back to workspaceDir
  const provider = manager.createCwdProvider();

  return { provider, manager };
}

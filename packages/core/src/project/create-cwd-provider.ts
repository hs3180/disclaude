/**
 * Factory function for creating a CwdProvider from config.
 *
 * Wires together ProjectManager construction with template discovery
 * and config loading, producing a ready-to-inject CwdProvider closure.
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import type { CwdProvider, ProjectTemplatesConfig } from './types.js';
import { ProjectManager } from './project-manager.js';
import { discoverTemplatesAsConfig } from './template-discovery.js';

/**
 * Options for creating a CwdProvider from config.
 */
export interface CreateCwdProviderOptions {
  /** Workspace root directory (parent of `projects/` instances dir) */
  workspaceDir: string;
  /** Package directory (contains `templates/` with built-in CLAUDE.md files) */
  packageDir?: string;
  /**
   * Template configuration from disclaude.config.yaml.
   * If not provided, templates will be auto-discovered from packageDir.
   */
  templatesConfig?: ProjectTemplatesConfig;
}

/**
 * Create a CwdProvider by wiring ProjectManager with config and template discovery.
 *
 * Resolution order for templates:
 * 1. If `templatesConfig` is provided → use it directly
 * 2. If `packageDir` is provided → auto-discover templates from `{packageDir}/templates/`
 * 3. Otherwise → no templates (all chatIds use default workspace)
 *
 * @param options - Configuration options
 * @returns Object containing the CwdProvider and the ProjectManager instance
 *
 * @example
 * ```typescript
 * import { createCwdProviderFromConfig } from '@disclaude/core';
 *
 * // From explicit config
 * const { cwdProvider, projectManager } = createCwdProviderFromConfig({
 *   workspaceDir: '/app/workspace',
 *   packageDir: '/app/packages/core',
 *   templatesConfig: {
 *     research: { displayName: '研究模式' },
 *   },
 * });
 *
 * // Inject into ChatAgent
 * agent.setCwdProvider(cwdProvider);
 * ```
 */
export function createCwdProviderFromConfig(
  options: CreateCwdProviderOptions,
): {
  cwdProvider: CwdProvider;
  projectManager: ProjectManager;
} {
  const { workspaceDir, packageDir } = options;

  // Resolve templates config: explicit → auto-discover → empty
  let {templatesConfig} = options;
  if (!templatesConfig && packageDir) {
    templatesConfig = discoverTemplatesAsConfig(packageDir);
  }

  // Create ProjectManager
  const projectManager = new ProjectManager({
    workspaceDir,
    packageDir: packageDir ?? workspaceDir,
    templatesConfig: templatesConfig ?? {},
  });

  // Create CwdProvider closure
  const cwdProvider = projectManager.createCwdProvider();

  return { cwdProvider, projectManager };
}

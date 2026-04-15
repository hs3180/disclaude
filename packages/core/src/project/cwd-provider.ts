/**
 * CwdProvider factory — creates a dynamic cwd resolver for Agent sessions.
 *
 * The CwdProvider is injected into ChatAgent/BaseAgent to determine the
 * working directory for each chat session. It queries the current project
 * binding for a chatId and returns the corresponding workingDir.
 *
 * When ProjectManager is available (Issue #2224), the getActive callback
 * will be wired to its state. Until then, a default no-op implementation
 * is provided that returns undefined (Agent falls back to workspaceDir).
 *
 * @see docs/proposals/unified-project-context.md §5.2
 * @see Issue #2227 (Sub-Issue E — integration)
 * @see Issue #1916 (parent — unified project context)
 */

import type { CwdProvider, ProjectContextConfig } from './types.js';

/**
 * Interface for querying the active project for a given chatId.
 *
 * Implemented by ProjectManager.getActive() (Issue #2224).
 * A no-op default is used when ProjectManager is not available.
 */
export interface ActiveProjectResolver {
  /**
   * Get the active project context for a chat session.
   *
   * @param chatId - The chat session identifier
   * @returns The project context if an active project is bound, undefined for default project
   */
  getActive(chatId: string): ProjectContextConfig | undefined;
}

/**
 * Create a CwdProvider from an ActiveProjectResolver.
 *
 * The returned CwdProvider closure dynamically resolves the working directory
 * for each chat session by querying the resolver for the active project.
 * Returns undefined for the "default" project, which causes BaseAgent to
 * fall back to Config.getWorkspaceDir().
 *
 * @param resolver - The project resolver (typically a ProjectManager instance)
 * @returns A CwdProvider function suitable for injection into BaseAgent
 *
 * @example
 * ```typescript
 * // With ProjectManager (Issue #2224)
 * const pm = new ProjectManager(options);
 * const cwdProvider = createCwdProvider(pm);
 * agent.setCwdProvider(cwdProvider);
 *
 * // Without ProjectManager (default behavior)
 * const cwdProvider = createCwdProvider();
 * // Always returns undefined → Agent uses workspaceDir
 * ```
 */
export function createCwdProvider(
  resolver?: ActiveProjectResolver,
): CwdProvider {
  return (chatId: string): string | undefined => {
    if (!resolver) {
      return undefined;
    }
    const project = resolver.getActive(chatId);
    return project?.workingDir;
  };
}

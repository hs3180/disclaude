/**
 * ProjectManager — simplified per-chatId working directory binding.
 *
 * Manages chatId → workingDir mappings in memory with atomic persistence
 * to `{workspace}/.disclaude/project-bindings.json`.
 *
 * Simplified design (Issue #3519): No templates or instances.
 * A project = an arbitrary working directory. ChatId binds directly to a path.
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (parent — unified ProjectContext system)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import * as path from 'node:path';
import type {
  CwdProvider,
  ProjectConfig,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Persistence schema for `.disclaude/project-bindings.json`.
 */
interface ProjectBindingsData {
  version: number;
  bindings: Record<string, string>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages chatId → workingDir bindings with persistence.
 *
 * Lifecycle:
 * 1. Construct with `{ workspaceDir }`
 * 2. Bindings are loaded from `.disclaude/project-bindings.json` automatically
 * 3. Use `use()`, `reset()`, `getActive()` to manage bindings
 * 4. Call `createCwdProvider()` to get a CwdProvider for Agent injection
 */
export class ProjectManager {
  private readonly workspaceDir: string;
  /** chatId → workingDir binding */
  private bindings: Map<string, string> = new Map();

  /** Config-driven projects, keyed by project key */
  private configProjects: Map<string, ProjectConfig> = new Map();

  /** Path to .disclaude directory */
  private readonly dataDir: string;
  /** Path to project-bindings.json */
  private readonly persistPath: string;
  /** Path to temporary file used during atomic write */
  private readonly persistTmpPath: string;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.dataDir = resolve(options.workspaceDir, '.disclaude');
    this.persistPath = resolve(this.dataDir, 'project-bindings.json');
    this.persistTmpPath = resolve(this.dataDir, 'project-bindings.json.tmp');

    // Register config-driven projects (Issue #3583)
    if (options.projects) {
      for (const project of options.projects) {
        this.configProjects.set(project.key, {
          ...project,
          workingDir: path.isAbsolute(project.workingDir)
            ? project.workingDir
            : resolve(this.workspaceDir, project.workingDir),
        });
      }
    }

    // Restore persisted state
    this.loadPersistedData();
  }

  // ───────────────────────────────────────────
  // Core Methods
  // ───────────────────────────────────────────

  /**
   * Get the active project context for a chatId.
   *
   * @param chatId - Chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
    const workingDir = this.bindings.get(chatId);
    if (workingDir) {
      return {
        name: basename(workingDir),
        workingDir,
      };
    }

    // Default: workspace root
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Bind a chatId to a working directory.
   *
   * Resolves relative paths against the workspace directory.
   * Validates that the directory path doesn't contain path traversal patterns.
   *
   * @param chatId - Chat session requesting binding
   * @param workingDir - Working directory path (relative or absolute)
   * @returns ProjectResult with ProjectContextConfig on success
   */
  use(chatId: string, workingDir: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const dirError = this.validateWorkingDir(workingDir);
    if (dirError) {
      return { ok: false, error: dirError };
    }

    // Resolve relative paths against workspaceDir
    const resolvedDir = resolve(this.workspaceDir, workingDir);

    // Save pre-mutation state for rollback
    const oldDir = this.bindings.get(chatId);

    this.bindings.set(chatId, resolvedDir);

    // Persist after mutation; rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback in-memory state
      if (oldDir !== undefined) {
        this.bindings.set(chatId, oldDir);
      } else {
        this.bindings.delete(chatId);
      }
      return { ok: false, error: persistResult.error };
    }

    return {
      ok: true,
      data: {
        name: basename(resolvedDir),
        workingDir: resolvedDir,
      },
    };
  }

  /**
   * Reset a chatId's binding, reverting to default workspace.
   *
   * @param chatId - Chat session to reset
   * @returns ProjectResult with default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Save pre-mutation state for rollback
    const boundDir = this.bindings.get(chatId);

    this.bindings.delete(chatId);

    // Persist after mutation; rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback in-memory state
      if (boundDir) {
        this.bindings.set(chatId, boundDir);
      }
      return { ok: false, error: persistResult.error };
    }

    return {
      ok: true,
      data: {
        name: 'default',
        workingDir: this.workspaceDir,
      },
    };
  }

  // ───────────────────────────────────────────
  // Query Methods
  // ───────────────────────────────────────────

  /**
   * List all current bindings.
   *
   * @returns Array of { chatId, workingDir } objects
   */
  listBindings(): Array<{ chatId: string; workingDir: string }> {
    return Array.from(this.bindings.entries()).map(([chatId, workingDir]) => ({
      chatId,
      workingDir,
    }));
  }

  // ───────────────────────────────────────────
  // Config-Driven Project Methods (Issue #3583)
  // ───────────────────────────────────────────

  /**
   * List all config-driven projects.
   *
   * @returns Array of ProjectConfig entries from disclaude.config.yaml
   */
  listConfigProjects(): ProjectConfig[] {
    return Array.from(this.configProjects.values());
  }

  /**
   * Get a config-driven project by its key.
   *
   * @param key - Project key (e.g. 'hs3180/disclaude')
   * @returns ProjectConfig or undefined if not found
   */
  getConfigProject(key: string): ProjectConfig | undefined {
    return this.configProjects.get(key);
  }

  // ───────────────────────────────────────────
  // CwdProvider Factory
  // ───────────────────────────────────────────

  /**
   * Create a CwdProvider closure bound to this ProjectManager.
   *
   * Injected into ChatAgent for dynamic cwd resolution.
   *
   * @returns CwdProvider function
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      // Return undefined for default → SDK falls back to getWorkspaceDir()
      if (active.name === 'default') {
        return undefined;
      }
      return active.workingDir;
    };
  }

  // ───────────────────────────────────────────
  // Persistence
  // ───────────────────────────────────────────

  /**
   * Persist current bindings to disk using atomic write-then-rename.
   *
   * @returns ProjectResult indicating success or failure
   */
  persist(): ProjectResult<void> {
    try {
      // Ensure .disclaude/ directory exists
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: ProjectBindingsData = {
        version: 1,
        bindings: {},
      };

      for (const [chatId, workingDir] of this.bindings.entries()) {
        data.bindings[chatId] = workingDir;
      }

      // Atomic write: write to .tmp, then rename
      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.persistTmpPath, json, 'utf8');

      try {
        renameSync(this.persistTmpPath, this.persistPath);
      } catch (renameErr) {
        // Clean up .tmp file if rename fails
        try {
          unlinkSync(this.persistTmpPath);
        } catch {
          // Ignore cleanup failure
        }
        return {
          ok: false,
          error: `持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Load persisted bindings from disk.
   *
   * Gracefully handles missing/corrupted files.
   */
  loadPersistedData(): ProjectResult<void> {
    if (!existsSync(this.persistPath)) {
      // First run — no persisted data
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validatePersistSchema(data)) {
        return { ok: false, error: 'project-bindings.json 格式无效，已跳过恢复' };
      }

      const persisted = data as ProjectBindingsData;

      // Restore bindings
      for (const [chatId, workingDir] of Object.entries(persisted.bindings)) {
        if (typeof workingDir === 'string' && workingDir.length > 0) {
          this.bindings.set(chatId, workingDir);
        }
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 project-bindings.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get the persist file path (for testing/debugging).
   */
  getPersistPath(): string {
    return this.persistPath;
  }

  /**
   * Get the workspace directory (for testing/debugging).
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Validate the top-level schema of persisted data.
   */
  private validatePersistSchema(data: unknown): data is ProjectBindingsData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (obj.version !== 1) {
      return false;
    }
    if (typeof obj.bindings !== 'object' || obj.bindings === null || Array.isArray(obj.bindings)) {
      return false;
    }
    return true;
  }

  /**
   * Validate a chatId.
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    return null;
  }

  /**
   * Validate a working directory path.
   */
  private validateWorkingDir(workingDir: string): string | null {
    if (!workingDir || workingDir.trim().length === 0) {
      return '工作目录路径不能为空';
    }

    // Path traversal protection
    if (workingDir.includes('..')) {
      return '工作目录路径不能包含 ".."（路径遍历防护）';
    }

    // Null byte protection
    if (workingDir.includes('\0')) {
      return '工作目录路径不能包含空字节';
    }

    return null;
  }
}

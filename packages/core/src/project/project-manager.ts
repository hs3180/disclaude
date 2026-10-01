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

import {
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type {
  CwdProvider,
  CwdResolution,
  ProjectContextConfig,
  ProjectJupyterNotebookReference,
  ProjectManagerOptions,
  ProjectResult,
} from './types.js';

const logger = createLogger('ProjectManager');

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

/** Persistence schema for Jupyter references, keyed by Project working directory. */
interface ProjectJupyterReferencesData {
  version: number;
  projects: Record<string, ProjectJupyterNotebookReference[]>;
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

  /** Path to .disclaude directory */
  private readonly dataDir: string;
  /** Path to project-bindings.json */
  private readonly persistPath: string;
  /** Path to temporary file used during atomic write */
  private readonly persistTmpPath: string;
  /** Path to Project-scoped Jupyter notebook references. */
  private readonly jupyterReferencesPath: string;
  /** Temporary path for atomic Jupyter reference writes. */
  private readonly jupyterReferencesTmpPath: string;
  /** Project working directory → Jupyter-managed notebook references. */
  private readonly jupyterReferences = new Map<string, ProjectJupyterNotebookReference[]>();

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.dataDir = resolve(options.workspaceDir, '.disclaude');
    this.persistPath = resolve(this.dataDir, 'project-bindings.json');
    this.persistTmpPath = resolve(this.dataDir, 'project-bindings.json.tmp');
    this.jupyterReferencesPath = resolve(this.dataDir, 'project-jupyter-references.json');
    this.jupyterReferencesTmpPath = resolve(this.dataDir, 'project-jupyter-references.json.tmp');

    // Restore persisted state
    this.loadPersistedData();
    this.loadJupyterReferences();
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

  /**
   * Read this chat's Project-scoped Jupyter notebook references.
   *
   * Chats bound to the same working directory share the same reference list;
   * changing Project resolves a different list. The returned objects are
   * copies so callers cannot mutate manager state without persistence.
   */
  getJupyterNotebookReferences(
    chatId: string
  ): ProjectResult<ProjectJupyterNotebookReference[]> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }
    const { workingDir } = this.getActive(chatId);
    return {
      ok: true,
      data: (this.jupyterReferences.get(workingDir) ?? []).map(cloneJupyterReference),
    };
  }

  /**
   * Link or refresh a Jupyter notebook reference for the active Project.
   *
   * The operation only persists identifiers and a Jupyter Contents path. It
   * does not read, copy, write, rename, or delete content on the Jupyter server.
   * References with the same service and stable document ID update in place;
   * when no stable document ID exists, the service-scoped content path is the
   * identity and a rename must be explicitly linked again.
   */
  linkJupyterNotebook(
    chatId: string,
    reference: ProjectJupyterNotebookReference
  ): ProjectResult<ProjectJupyterNotebookReference> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }
    const validationError = validateJupyterReference(reference);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    const { workingDir } = this.getActive(chatId);
    const previous = this.jupyterReferences.get(workingDir) ?? [];
    const sanitized = cloneJupyterReference(reference);
    const key = jupyterReferenceKey(sanitized);
    const existingIndex = previous.findIndex((item) => jupyterReferenceKey(item) === key);
    const next = [...previous];
    if (existingIndex === -1) {
      next.push(sanitized);
    } else {
      next[existingIndex] = sanitized;
    }
    this.jupyterReferences.set(workingDir, next);
    const persistResult = this.persistJupyterReferences();
    if (!persistResult.ok) {
      if (previous.length === 0) {
        this.jupyterReferences.delete(workingDir);
      } else {
        this.jupyterReferences.set(workingDir, previous);
      }
      return { ok: false, error: persistResult.error };
    }
    return { ok: true, data: cloneJupyterReference(sanitized) };
  }

  /**
   * Unlink a Jupyter notebook reference from the active Project.
   *
   * This only removes the local association; the remote notebook and its
   * kernels are never deleted or stopped.
   */
  unlinkJupyterNotebook(
    chatId: string,
    reference: Pick<
      ProjectJupyterNotebookReference,
      'connectionId' | 'serverNamespace' | 'contentPath' | 'documentId'
    >
  ): ProjectResult<boolean> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }
    const validationError = validateJupyterReference(reference);
    if (validationError) {
      return { ok: false, error: validationError };
    }

    const { workingDir } = this.getActive(chatId);
    const previous = this.jupyterReferences.get(workingDir) ?? [];
    const key = jupyterReferenceKey(reference);
    const next = previous.filter((item) => jupyterReferenceKey(item) !== key);
    if (next.length === previous.length) {
      return { ok: true, data: false };
    }
    if (next.length === 0) {
      this.jupyterReferences.delete(workingDir);
    } else {
      this.jupyterReferences.set(workingDir, next);
    }
    const persistResult = this.persistJupyterReferences();
    if (!persistResult.ok) {
      this.jupyterReferences.set(workingDir, previous);
      return { ok: false, error: persistResult.error };
    }
    return { ok: true, data: true };
  }

  // ───────────────────────────────────────────
  // CwdProvider Factory
  // ───────────────────────────────────────────

  /**
   * Resolve the effective cwd for a chat session, structured so callers can
   * tell *why* it differs from the bound target.
   *
   * `createCwdProvider` only returns the cwd (or `undefined`), so a
   * bound-but-missing directory was indistinguishable from "unbound" — the
   * silent fallback to workspace went unnoticed (Issue #4448). `resolveCwd`
   * exposes the bound target, the effective cwd, and the reason, so callers
   * like `/project info` (and future user-visible warnings) can surface the
   * mismatch instead of hiding behind a single `undefined`.
   *
   * Issue #3977: still validates that the bound directory exists; the only
   * change is that the outcome is now introspectable.
   *
   * @returns CwdResolution with effective cwd + reason
   */
  resolveCwd(chatId: string): CwdResolution {
    const active = this.getActive(chatId);
    // default → unbound; SDK falls back to getWorkspaceDir()
    if (active.name === 'default') {
      return {
        effectiveCwd: undefined,
        boundWorkingDir: undefined,
        reason: 'unbound',
      };
    }
    // Issue #3977: validate the bound directory exists before trusting it
    if (!existsSync(active.workingDir)) {
      return {
        effectiveCwd: undefined,
        boundWorkingDir: active.workingDir,
        reason: 'bound-missing',
      };
    }
    return {
      effectiveCwd: active.workingDir,
      boundWorkingDir: active.workingDir,
      reason: 'bound',
    };
  }

  /**
   * Create a CwdProvider closure bound to this ProjectManager.
   *
   * Injected into ChatAgent for dynamic cwd resolution. Delegates to
   * `resolveCwd()` so the reason logic lives in one place; preserves the
   * Issue #3977 `logger.warn` on the bound-but-missing fallback.
   *
   * @returns CwdProvider function
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const resolution = this.resolveCwd(chatId);
      if (resolution.reason === 'bound-missing') {
        logger.warn(
          { chatId, workingDir: resolution.boundWorkingDir },
          'Bound project directory does not exist, falling back to workspace'
        );
      }
      return resolution.effectiveCwd;
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

  /** Persist Project-scoped Jupyter references atomically. */
  private persistJupyterReferences(): ProjectResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: ProjectJupyterReferencesData = { version: 1, projects: {} };
      for (const [workingDir, references] of this.jupyterReferences.entries()) {
        data.projects[workingDir] = references.map(cloneJupyterReference);
      }
      writeFileSync(this.jupyterReferencesTmpPath, JSON.stringify(data, null, 2), 'utf8');
      try {
        renameSync(this.jupyterReferencesTmpPath, this.jupyterReferencesPath);
      } catch (renameErr) {
        try {
          unlinkSync(this.jupyterReferencesTmpPath);
        } catch {
          // Ignore cleanup failure.
        }
        return {
          ok: false,
          error: `Jupyter 引用持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        };
      }
      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `Jupyter 引用持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Load service references without reading remote notebook content. */
  private loadJupyterReferences(): ProjectResult<void> {
    if (!existsSync(this.jupyterReferencesPath)) {
      return { ok: true, data: undefined };
    }
    try {
      const raw = readFileSync(this.jupyterReferencesPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isProjectJupyterReferencesData(parsed)) {
        return { ok: false, error: 'project-jupyter-references.json 格式无效，已跳过恢复' };
      }
      for (const [workingDir, entries] of Object.entries(parsed.projects)) {
        if (typeof workingDir !== 'string' || workingDir.length === 0 || !Array.isArray(entries)) {
          continue;
        }
        const validEntries = entries.filter(
          (entry): entry is ProjectJupyterNotebookReference =>
            validateJupyterReference(entry) === null
        );
        if (validEntries.length > 0) {
          this.jupyterReferences.set(workingDir, validEntries.map(cloneJupyterReference));
        }
      }
      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 project-jupyter-references.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /** Get the Jupyter reference metadata path (for testing/debugging). */
  getJupyterReferencesPersistPath(): string {
    return this.jupyterReferencesPath;
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

function validateJupyterReference(reference: unknown): string | null {
  if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
    return 'Jupyter notebook reference must be an object';
  }
  const candidate = reference as Partial<ProjectJupyterNotebookReference>;
  if (!isOpaqueIdentifier(candidate.connectionId, 200)) {
    return 'Jupyter connectionId is required and must be a trimmed identifier';
  }
  if (!isOpaqueIdentifier(candidate.serverNamespace, 200)) {
    return 'Jupyter serverNamespace is required and must be a trimmed identifier';
  }
  if (
    typeof candidate.contentPath !== 'string' ||
    candidate.contentPath.length === 0 ||
    candidate.contentPath.length > 1024 ||
    candidate.contentPath !== candidate.contentPath.trim() ||
    candidate.contentPath.startsWith('/') ||
    candidate.contentPath.endsWith('/') ||
    candidate.contentPath.includes('\\') ||
    candidate.contentPath.includes('\0') ||
    !candidate.contentPath.toLowerCase().endsWith('.ipynb') ||
    candidate.contentPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return 'Jupyter contentPath must be a relative .ipynb path without traversal segments';
  }
  if (candidate.documentId !== undefined && !isOpaqueIdentifier(candidate.documentId, 500)) {
    return 'Jupyter documentId must be a trimmed identifier when provided';
  }
  if (
    candidate.lastKnownVersion !== undefined &&
    !isOpaqueIdentifier(candidate.lastKnownVersion, 1000)
  ) {
    return 'Jupyter lastKnownVersion must be a trimmed identifier when provided';
  }
  return null;
}

function isOpaqueIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !value.includes('://') &&
    !/[?#]/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function cloneJupyterReference(
  reference: ProjectJupyterNotebookReference
): ProjectJupyterNotebookReference {
  return {
    connectionId: reference.connectionId,
    serverNamespace: reference.serverNamespace,
    ...(reference.documentId !== undefined ? { documentId: reference.documentId } : {}),
    contentPath: reference.contentPath,
    ...(reference.lastKnownVersion !== undefined
      ? { lastKnownVersion: reference.lastKnownVersion }
      : {}),
  };
}

function jupyterReferenceKey(
  reference: Pick<
    ProjectJupyterNotebookReference,
    'connectionId' | 'serverNamespace' | 'contentPath' | 'documentId'
  >
): string {
  const documentIdentity = reference.documentId
    ? `document:${reference.documentId}`
    : `path:${reference.contentPath}`;
  return `${reference.connectionId}\0${reference.serverNamespace}\0${documentIdentity}`;
}

function isProjectJupyterReferencesData(data: unknown): data is ProjectJupyterReferencesData {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.projects === 'object' &&
    record.projects !== null &&
    !Array.isArray(record.projects)
  );
}

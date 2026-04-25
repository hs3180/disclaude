/**
 * ProjectManager — core in-memory + persistent logic for per-chatId Agent context switching.
 *
 * Manages project templates, instances, and chatId bindings in memory,
 * with atomic persistence to `{workspace}/.disclaude/projects.json`.
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — persistence layer)
 * @see Issue #1916 (parent — unified ProjectContext system)
 */

import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  CwdProvider,
  InstanceInfo,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
  ProjectsPersistData,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Maximum allowed length for instance names */
const MAX_NAME_LENGTH = 64;

/** Characters forbidden in instance names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal representation of a project instance (in-memory only).
 */
interface ProjectInstance {
  name: string;
  templateName: string;
  workingDir: string;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings in pure memory.
 *
 * Lifecycle:
 * 1. Construct with `ProjectManagerOptions`
 * 2. Call `init()` (or `init(templatesConfig)`) to load templates
 * 3. Use `create()`, `use()`, `getActive()`, `reset()` to manage projects
 * 4. Call `createCwdProvider()` to get a CwdProvider for Agent injection
 *
 * Zero-config: if no templates are configured, behavior is identical to
 * the current system (all chatIds use workspace root as cwd).
 */
export class ProjectManager {
  private readonly workspaceDir: string;
  /** Package directory containing templates/ with CLAUDE.md files. Empty = skip FS ops. */
  private readonly packageDir: string;
  private templates: Map<string, ProjectTemplate> = new Map();
  private instances: Map<string, ProjectInstance> = new Map();
  /** chatId → instance name binding */
  private chatProjectMap: Map<string, string> = new Map();
  /** Reverse index: instance name → Set of bound chatIds (O(1) lookup) */
  private instanceChatIds: Map<string, Set<string>> = new Map();

  /** Path to .disclaude directory */
  private readonly dataDir: string;
  /** Path to projects.json */
  private readonly persistPath: string;
  /** Path to temporary file used during atomic write */
  private readonly persistTmpPath: string;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir ?? '';
    this.dataDir = join(options.workspaceDir, '.disclaude');
    this.persistPath = join(this.dataDir, 'projects.json');
    this.persistTmpPath = join(this.dataDir, 'projects.json.tmp');

    this.init(options.templatesConfig);

    // Restore persisted state after templates are loaded
    this.loadPersistedData();
  }

  // ───────────────────────────────────────────
  // Initialization
  // ───────────────────────────────────────────

  /**
   * Initialize (or re-initialize) templates from config.
   *
   * Does NOT clear existing instances or bindings — templates can be
   * hot-reloaded without losing runtime state.
   *
   * @param templatesConfig - Template configuration (from disclaude.config.yaml or auto-discovery)
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    this.templates.clear();

    if (!templatesConfig) {
      return;
    }

    for (const [name, meta] of Object.entries(templatesConfig)) {
      this.templates.set(name, {
        name,
        displayName: meta.displayName,
        description: meta.description,
      });
    }
  }

  // ───────────────────────────────────────────
  // Core Methods
  // ───────────────────────────────────────────

  /**
   * Get the active project context for a chatId.
   *
   * Stale binding self-healing: if the bound instance no longer exists,
   * the binding is automatically removed and the default context is returned.
   *
   * @param chatId - Chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
    // Check for explicit binding
    const boundName = this.chatProjectMap.get(chatId);
    if (boundName) {
      const instance = this.instances.get(boundName);
      if (instance) {
        return {
          name: instance.name,
          templateName: instance.templateName,
          workingDir: instance.workingDir,
        };
      }

      // Stale binding self-healing: instance was removed, clean up binding
      this.chatProjectMap.delete(chatId);
      this.removeFromReverseIndex(boundName, chatId);
      // Persist the cleaned-up state
      this.persist();
    }

    // Default: workspace root
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Create a new project instance from a template.
   *
   * When packageDir is configured, also creates the working directory and
   * copies CLAUDE.md from the template (Sub-Issue D — #2226).
   * When packageDir is empty, only creates the in-memory instance.
   *
   * The workingDir is computed as `{workspaceDir}/projects/{name}/`.
   *
   * @param chatId - Chat session requesting creation
   * @param templateName - Template to instantiate from
   * @param name - Unique name for the new instance
   * @returns ProjectResult with ProjectContextConfig on success
   */
  create(chatId: string, templateName: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate inputs
    const nameError = this.validateInstanceName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Check template exists
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在` };
    }

    // Check name uniqueness
    if (this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 已存在` };
    }

    const workingDir = this.resolveWorkingDir(name);
    const instance: ProjectInstance = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(name, instance);
    this.chatProjectMap.set(chatId, name);
    this.addToReverseIndex(name, chatId);

    // Filesystem instantiation (Sub-Issue D — #2226)
    if (this.packageDir) {
      const fsResult = this.instantiateFromTemplate(name, templateName);
      if (!fsResult.ok) {
        // Rollback in-memory state
        this.instances.delete(name);
        this.chatProjectMap.delete(chatId);
        this.removeFromReverseIndex(name, chatId);
        return { ok: false, error: fsResult.error };
      }
    }

    // Persist after mutation
    this.persist();

    return {
      ok: true,
      data: {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
      },
    };
  }

  /**
   * Bind a chatId to an existing instance.
   *
   * @param chatId - Chat session requesting binding
   * @param name - Instance name to bind to
   * @returns ProjectResult with ProjectContextConfig on success
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Remove from old instance's reverse index if rebinding
    const oldName = this.chatProjectMap.get(chatId);
    if (oldName && oldName !== name) {
      this.removeFromReverseIndex(oldName, chatId);
    }

    this.chatProjectMap.set(chatId, name);
    this.addToReverseIndex(name, chatId);

    // Persist after mutation
    this.persist();

    return {
      ok: true,
      data: {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
      },
    };
  }

  /**
   * Reset a chatId's binding, reverting to default project.
   *
   * @param chatId - Chat session to reset
   * @returns ProjectResult with default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const boundName = this.chatProjectMap.get(chatId);
    this.chatProjectMap.delete(chatId);
    if (boundName) {
      this.removeFromReverseIndex(boundName, chatId);
    }

    // Persist after mutation
    this.persist();

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
   * List all available templates.
   *
   * @returns Array of templates sorted by name
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * List all instances with their binding information.
   *
   * Does NOT include the implicit "default" project.
   *
   * @returns Array of InstanceInfo sorted by creation time
   */
  listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];

    for (const instance of this.instances.values()) {
      const chatIds = this.getBoundChatIds(instance.name);
      result.push({
        name: instance.name,
        templateName: instance.templateName,
        chatIds,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }

    return result.sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
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
  // Persistence Methods (Sub-Issue C)
  // ───────────────────────────────────────────

  /**
   * Persist current in-memory state to disk using atomic write-then-rename.
   *
   * Writes to a `.tmp` file first, then renames to the final path.
   * If rename fails, the `.tmp` file is cleaned up.
   * Creates `.disclaude/` directory if it doesn't exist.
   *
   * @returns ProjectResult indicating success or failure
   */
  persist(): ProjectResult<void> {
    try {
      // Ensure .disclaude/ directory exists
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: ProjectsPersistData = {
        instances: {},
        chatProjectMap: {},
      };

      // Serialize instances
      for (const [name, instance] of this.instances.entries()) {
        data.instances[name] = {
          name: instance.name,
          templateName: instance.templateName,
          workingDir: instance.workingDir,
          createdAt: instance.createdAt,
        };
      }

      // Serialize bindings
      for (const [chatId, boundName] of this.chatProjectMap.entries()) {
        data.chatProjectMap[chatId] = boundName;
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
   * Load persisted data from disk and restore in-memory state.
   *
   * Schema validation:
   * - `instances` must be an object with valid `workingDir` (string) and `createdAt` (non-empty string)
   * - `chatProjectMap` must be an object with string values
   *
   * Corrupted or invalid files are handled gracefully:
   * - File not found → silently skip (first run)
   * - Invalid JSON → log error, skip (don't crash)
   * - Schema validation failure → skip invalid entries
   *
   * @returns ProjectResult indicating success or failure
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
        return { ok: false, error: 'projects.json 格式无效，已跳过恢复' };
      }

      const persisted = data as ProjectsPersistData;

      // Restore instances (skip invalid entries)
      for (const [name, inst] of Object.entries(persisted.instances)) {
        if (
          typeof inst !== 'object' || inst === null ||
          typeof inst.workingDir !== 'string' || inst.workingDir.length === 0 ||
          typeof inst.createdAt !== 'string' || inst.createdAt.length === 0 ||
          typeof inst.templateName !== 'string'
        ) {
          continue; // Skip invalid entry
        }
        this.instances.set(name, {
          name: inst.name,
          templateName: inst.templateName,
          workingDir: inst.workingDir,
          createdAt: inst.createdAt,
        });
      }

      // Restore bindings (only for instances that were successfully loaded)
      for (const [chatId, boundName] of Object.entries(persisted.chatProjectMap)) {
        if (typeof boundName === 'string' && this.instances.has(boundName)) {
          this.chatProjectMap.set(chatId, boundName);
          // Rebuild reverse index for O(1) listInstances() lookups
          this.addToReverseIndex(boundName, chatId);
        }
      }

      return { ok: true, data: undefined };
    } catch (err) {
      // Corrupted file — don't crash, just skip
      return {
        ok: false,
        error: `读取 projects.json 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get the persist file path (for testing/debugging).
   *
   * @returns Absolute path to projects.json
   */
  getPersistPath(): string {
    return this.persistPath;
  }

  // ───────────────────────────────────────────
  // Internal Helpers
  // ───────────────────────────────────────────

  /**
   * Resolve the working directory for an instance.
   *
   * Pattern: `{workspaceDir}/projects/{name}/`
   *
   * @param name - Instance name
   * @returns Absolute working directory path
   */
  private resolveWorkingDir(name: string): string {
    // Use simple path join (path traversal already validated in create())
    // Avoid importing `path` to keep this module filesystem-free
    const ws = this.workspaceDir.replace(/\/+$/, '');
    return `${ws}/projects/${name}`;
  }

  // ───────────────────────────────────────────
  // Filesystem Instantiation (Sub-Issue D — #2226)
  // ───────────────────────────────────────────

  /**
   * Instantiate a project's working directory and copy CLAUDE.md from template.
   *
   * Steps:
   * 1. Validate resolved path is within workspaceDir (path traversal defense-in-depth)
   * 2. Create working directory with `mkdirSync({ recursive: true })`
   * 3. Copy CLAUDE.md from template via `copyClaudeMd()`
   * 4. On copy failure: rollback by removing the created directory
   *
   * @param name - Instance name
   * @param templateName - Source template name
   * @returns ProjectResult indicating success or failure
   */
  private instantiateFromTemplate(name: string, templateName: string): ProjectResult<void> {
    const targetDir = this.resolveWorkingDir(name);

    // Path traversal defense-in-depth: verify resolved path is within workspaceDir
    const resolvedTarget = resolve(targetDir);
    const resolvedWorkspace = resolve(this.workspaceDir);
    if (
      !resolvedTarget.startsWith(`${resolvedWorkspace}/`) &&
      resolvedTarget !== resolvedWorkspace
    ) {
      return {
        ok: false,
        error: '工作目录路径不在工作空间内（路径遍历防护）',
      };
    }

    // Create working directory
    try {
      mkdirSync(targetDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: `创建工作目录失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Copy CLAUDE.md from template
    const copyResult = this.copyClaudeMd(templateName, targetDir);
    if (!copyResult.ok) {
      // Rollback: remove created directory
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure — best effort rollback
      }
      return copyResult;
    }

    return { ok: true, data: undefined };
  }

  /**
   * Copy CLAUDE.md from a template directory to the target working directory.
   *
   * Behavior:
   * - packageDir not configured → skip (instance without CLAUDE.md, creation succeeds)
   * - Template CLAUDE.md not found → error (triggers rollback in caller)
   * - Template CLAUDE.md found → copy to `{targetDir}/CLAUDE.md`
   *
   * @param templateName - Source template name
   * @param targetDir - Target working directory
   * @returns ProjectResult indicating success or failure
   */
  private copyClaudeMd(templateName: string, targetDir: string): ProjectResult<void> {
    // Skip if packageDir not configured
    if (!this.packageDir) {
      return { ok: true, data: undefined };
    }

    const sourcePath = join(this.packageDir, 'templates', templateName, 'CLAUDE.md');

    // Template CLAUDE.md must exist when packageDir is configured
    if (!existsSync(sourcePath)) {
      return {
        ok: false,
        error: `模板 "${templateName}" 的 CLAUDE.md 文件不存在`,
      };
    }

    try {
      copyFileSync(sourcePath, join(targetDir, 'CLAUDE.md'));
    } catch (err) {
      return {
        ok: false,
        error: `复制 CLAUDE.md 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { ok: true, data: undefined };
  }

  /**
   * Get all chatIds bound to a specific instance.
   *
   * Uses reverse index for O(1) lookup per instance.
   *
   * @param instanceName - Instance name to look up
   * @returns Array of bound chatIds
   */
  private getBoundChatIds(instanceName: string): string[] {
    const set = this.instanceChatIds.get(instanceName);
    return set ? [...set] : [];
  }

  /**
   * Add a chatId to an instance's reverse index set.
   */
  private addToReverseIndex(instanceName: string, chatId: string): void {
    let set = this.instanceChatIds.get(instanceName);
    if (!set) {
      set = new Set();
      this.instanceChatIds.set(instanceName, set);
    }
    set.add(chatId);
  }

  /**
   * Remove a chatId from an instance's reverse index set.
   * Cleans up empty sets to avoid memory leaks.
   */
  private removeFromReverseIndex(instanceName: string, chatId: string): void {
    const set = this.instanceChatIds.get(instanceName);
    if (set) {
      set.delete(chatId);
      if (set.size === 0) {
        this.instanceChatIds.delete(instanceName);
      }
    }
  }

  // ───────────────────────────────────────────
  // Persistence Helpers
  // ───────────────────────────────────────────

  /**
   * Validate the top-level schema of persisted data.
   *
   * Checks that `instances` and `chatProjectMap` are objects (not null, not arrays).
   * Individual entry validation is done during restoration.
   *
   * @param data - Parsed JSON data to validate
   * @returns true if schema is structurally valid
   */
  private validatePersistSchema(data: unknown): data is ProjectsPersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (typeof obj.instances !== 'object' || obj.instances === null || Array.isArray(obj.instances)) {
      return false;
    }
    if (typeof obj.chatProjectMap !== 'object' || obj.chatProjectMap === null || Array.isArray(obj.chatProjectMap)) {
      return false;
    }
    return true;
  }

  // ───────────────────────────────────────────
  // Validation
  // ───────────────────────────────────────────

  /**
   * Validate an instance name.
   *
   * Rules:
   * - Must be non-empty
   * - Must not be "default" (reserved)
   * - Must not contain ".." (path traversal)
   * - Must not contain "/" or "\" (path separators)
   * - Must not contain null bytes
   * - Must not exceed 64 characters
   * - Must not be whitespace-only
   *
   * @param name - Instance name to validate
   * @returns Error message string, or null if valid
   */
  private validateInstanceName(name: string): string | null {
    if (!name || name.length === 0) {
      return '实例名称不能为空';
    }
    if (name === 'default') {
      return '"default" 是保留名称，不能用作实例名';
    }
    if (name === '..' || name.includes('..')) {
      return '实例名称不能包含 ".."（路径遍历防护）';
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      return '实例名称不能包含 /、\\ 或空字节';
    }
    if (name.trim().length === 0) {
      return '实例名称不能仅包含空白字符';
    }
    if (name.length > MAX_NAME_LENGTH) {
      return `实例名称不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate a chatId.
   *
   * @param chatId - Chat session identifier
   * @returns Error message string, or null if valid
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    return null;
  }
}

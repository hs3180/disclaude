/**
 * ProjectManager core logic — in-memory operations with optional persistence
 * and filesystem instantiation.
 *
 * Manages project template loading, instance creation, and chatId binding
 * in memory. When `persistDir` is provided in options, mutations are
 * atomically persisted to `{persistDir}/projects.json` using write-then-rename.
 * Sub-Issue D adds filesystem operations (directory creation, CLAUDE.md copy)
 * integrated into the `create()` method.
 *
 * Key design decisions:
 * - `ProjectResult<T>` unified return type — validation failures return
 *   `{ ok: false, error }` instead of throwing
 * - Stale binding self-healing — if a chatId is bound to a deleted instance,
 *   the binding is silently removed
 * - Path traversal protection on all name inputs AND working directory paths
 * - "default" is a reserved name (implicit built-in project)
 * - Atomic persistence via writeFileSync + renameSync (no partial writes)
 * - Schema validation on load (corrupt files produce clear errors)
 * - Filesystem rollback: if CLAUDE.md copy fails, created directory is removed
 *
 * @see docs/proposals/unified-project-context.md §4 API Design
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — Persistence)
 * @see Issue #2226 (Sub-Issue D — Filesystem operations)
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal State
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Internal representation of a project instance.
 *
 * Extends ProjectContextConfig with creation timestamp for listInstances().
 */
interface InternalInstance {
  /** Instance name */
  name: string;

  /** Source template name */
  templateName: string;

  /** Instance working directory */
  workingDir: string;

  /** ISO 8601 creation timestamp */
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Validation Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Characters forbidden in instance/project names */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

/** Maximum name length */
const MAX_NAME_LENGTH = 64;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages project templates, instances, and chatId bindings in memory,
 * with optional atomic persistence to disk.
 *
 * Lifecycle:
 * 1. Construct with workspaceDir, packageDir, templatesConfig, (optional) persistDir
 * 2. If persistDir is set, load persisted state from disk
 * 3. Templates loaded automatically via init()
 * 4. Create instances from templates, bind chatIds, query active project
 * 5. Mutations (create/use/reset/delete) auto-persist when persistDir is set
 *
 * Thread safety: Not thread-safe. Single-threaded use only.
 */
export class ProjectManager {
  private templates: Map<string, ProjectTemplate> = new Map();
  private instances: Map<string, InternalInstance> = new Map();
  private chatProjectMap: Map<string, string> = new Map();

  private readonly workspaceDir: string;
  private readonly packageDir: string;
  private readonly persistDir: string | undefined;

  /**
   * Create a new ProjectManager.
   *
   * When `persistDir` is provided in options, the manager will:
   * - Load existing persisted data from `{persistDir}/projects.json` on construction
   * - Auto-persist after every successful mutation (create/use/reset/delete)
   * - Create `{persistDir}/` directory if it does not exist
   *
   * @param options - Constructor options including workspace/package dirs and template config
   */
  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir;
    this.persistDir = options.persistDir;
    this.init(options.templatesConfig);

    // Load persisted state after templates are initialized
    if (this.persistDir) {
      const loadResult = this.loadPersistedData();
      if (loadResult.ok) {
        this.restoreFromPersistData(loadResult.data);
      }
      // If load fails (file missing, corrupt), start fresh — not an error
    }
  }

  // ── Initialization ──

  /**
   * Load templates from config (not filesystem).
   *
   * Clears existing templates and reloads from the provided config.
   * Does NOT clear existing instances or bindings — templates can be
   * reloaded independently.
   *
   * @param templatesConfig - Template configuration from disclaude.config.yaml
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    this.templates.clear();

    if (templatesConfig) {
      for (const [name, meta] of Object.entries(templatesConfig)) {
        this.templates.set(name, {
          name,
          displayName: meta.displayName,
          description: meta.description,
        });
      }
    }
  }

  // ── Core Methods ──

  /**
   * Get the active project configuration for a chatId.
   *
   * Implements stale binding self-healing: if a chatId is bound to
   * a project name that no longer exists in the instances map,
   * the binding is silently removed and the default project is returned.
   *
   * @param chatId - The chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
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
      // Stale binding self-healing: instance was deleted, clean up binding
      this.chatProjectMap.delete(chatId);
    }

    // Return default project
    return {
      name: 'default',
      workingDir: this.workspaceDir,
    };
  }

  /**
   * Create a new project instance from a template and bind it to a chatId.
   *
   * Performs both in-memory registration and filesystem instantiation:
   * 1. Validates inputs
   * 2. Creates instance in memory
   * 3. Instantiates on filesystem (creates directory + copies CLAUDE.md)
   * 4. Persists state to disk (if persistDir configured)
   *
   * On failure at any step, previous steps are rolled back.
   *
   * @param chatId - The chat session to bind
   * @param templateName - The template to instantiate from
   * @param name - The unique instance name (user-specified)
   * @returns ProjectResult with the new ProjectContextConfig on success
   */
  create(
    chatId: string,
    templateName: string,
    name: string,
  ): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Validate templateName
    if (!this.templates.has(templateName)) {
      return { ok: false, error: `模板 "${templateName}" 不存在` };
    }

    // Validate name
    const nameError = this.validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check if instance already exists
    if (this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 已存在，请使用 /project use 绑定` };
    }

    // Create instance in memory
    const workingDir = path.join(this.workspaceDir, 'projects', name);
    const instance: InternalInstance = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(name, instance);
    this.chatProjectMap.set(chatId, name);

    // Filesystem instantiation (Sub-Issue D)
    const fsResult = this.instantiateFromTemplate(name, templateName);
    if (!fsResult.ok) {
      // Rollback: remove in-memory state
      this.instances.delete(name);
      this.chatProjectMap.delete(chatId);
      return { ok: false, error: fsResult.error };
    }

    // Auto-persist after successful mutation
    const persistError = this.tryPersist();
    if (persistError) {
      // Rollback: remove in-memory state (filesystem dir left for later cleanup)
      this.instances.delete(name);
      this.chatProjectMap.delete(chatId);
      return { ok: false, error: `持久化失败: ${persistError}` };
    }

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
   * Bind a chatId to an existing project instance.
   *
   * Multiple chatIds can bind to the same instance (shared workspace).
   *
   * @param chatId - The chat session to bind
   * @param name - The existing instance name
   * @returns ProjectResult with the bound ProjectContextConfig on success
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Validate name
    const nameError = this.validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check if instance exists
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Bind chatId to instance
    this.chatProjectMap.set(chatId, name);

    // Auto-persist after successful mutation
    const persistError = this.tryPersist();
    if (persistError) {
      // Rollback: remove binding
      this.chatProjectMap.delete(chatId);
      return { ok: false, error: `持久化失败: ${persistError}` };
    }

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
   * Reset a chatId's binding back to the default project.
   *
   * If the chatId is already unbound (default), this is a silent no-op
   * that still returns success.
   *
   * @param chatId - The chat session to reset
   * @returns ProjectResult with the default ProjectContextConfig
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    // Remove binding (no-op if not bound)
    this.chatProjectMap.delete(chatId);

    // Auto-persist after successful mutation
    const persistError = this.tryPersist();
    if (persistError) {
      return { ok: false, error: `持久化失败: ${persistError}` };
    }

    return {
      ok: true,
      data: {
        name: 'default',
        workingDir: this.workspaceDir,
      },
    };
  }

  /**
   * List all available templates.
   *
   * @returns Array of all loaded templates
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all project instances with their binding information.
   *
   * Does NOT include the "default" project (implicit built-in).
   *
   * @returns Array of InstanceInfo objects
   */
  listInstances(): InstanceInfo[] {
    const result: InstanceInfo[] = [];

    for (const [name, instance] of this.instances) {
      // Collect all chatIds bound to this instance
      const chatIds: string[] = [];
      for (const [chatId, boundName] of this.chatProjectMap) {
        if (boundName === name) {
          chatIds.push(chatId);
        }
      }

      result.push({
        name,
        templateName: instance.templateName,
        chatIds,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }

    return result;
  }

  /**
   * Create a CwdProvider closure for injecting into Pilot.
   *
   * The returned function queries the active project for a given chatId
   * and returns its workingDir, or undefined for the default project
   * (allowing the SDK to fall back to getWorkspaceDir()).
   *
   * @returns CwdProvider closure bound to this ProjectManager
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      if (active.name === 'default') {
        return undefined;
      }
      return active.workingDir;
    };
  }

  /**
   * Delete a project instance from memory (internal, for D phase rollback).
   *
   * Does NOT unbind chatIds — they will self-heal on next getActive().
   * Does NOT persist — caller is responsible for persistence if needed.
   *
   * @param name - Instance name to delete
   * @returns true if the instance existed and was deleted
   */
  deleteInstance(name: string): boolean {
    return this.instances.delete(name);
  }

  /**
   * Delete a project instance completely (memory + persisted state + bindings).
   *
   * Unlike `deleteInstance()` (internal rollback helper), this method:
   * 1. Removes all chatId bindings to the instance
   * 2. Removes the instance from memory
   * 3. Persists the updated state to disk
   *
   * @param name - Instance name to delete
   * @returns ProjectResult indicating success or failure
   */
  delete(name: string): ProjectResult<void> {
    // Validate name
    const nameError = this.validateName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    // Check if instance exists
    if (!this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Remove all chatId bindings to this instance
    for (const [chatId, boundName] of this.chatProjectMap) {
      if (boundName === name) {
        this.chatProjectMap.delete(chatId);
      }
    }

    // Remove instance from memory
    this.instances.delete(name);

    // Auto-persist after successful deletion
    const persistError = this.tryPersist();
    if (persistError) {
      return { ok: false, error: `持久化失败: ${persistError}` };
    }

    return { ok: true, data: undefined };
  }

  // ── Filesystem Operations (Sub-Issue D) ──

  /**
   * Instantiate a project template on the filesystem.
   *
   * Creates the working directory at `{workspaceDir}/projects/{name}/`
   * and copies CLAUDE.md from the template directory.
   *
   * Security:
   * - Path traversal protection: verifies resolved path is within workspaceDir
   * - Uses resolved (absolute) paths for comparison to prevent symlink attacks
   *
   * Rollback:
   * - If CLAUDE.md copy fails, the created directory is removed
   *
   * @param name - Instance name (used as directory name)
   * @param templateName - Source template name (for CLAUDE.md lookup)
   * @returns ProjectResult indicating success or failure
   */
  instantiateFromTemplate(name: string, templateName: string): ProjectResult<void> {
    const workingDir = path.join(this.workspaceDir, 'projects', name);

    // Path traversal protection: verify resolved path is within workspaceDir
    const pathError = this.validateWorkingDirPath(workingDir);
    if (pathError) {
      return { ok: false, error: pathError };
    }

    try {
      // Create working directory (idempotent with recursive: true)
      fs.mkdirSync(workingDir, { recursive: true });

      // Copy CLAUDE.md from template
      const copyResult = this.copyClaudeMd(templateName, workingDir);
      if (!copyResult.ok) {
        // Rollback: remove created directory
        try {
          fs.rmSync(workingDir, { recursive: true, force: true });
        } catch {
          // Ignore cleanup failure — orphaned dir can be cleaned up later
        }
        return copyResult;
      }

      return { ok: true, data: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `创建工作目录失败: ${message}` };
    }
  }

  /**
   * Copy CLAUDE.md from a template to the target instance directory.
   *
   * Behavior:
   * - If packageDir is not configured (empty string), skip silently (success)
   *   This allows instances to be created without CLAUDE.md
   * - If template CLAUDE.md exists, copy it to `{targetDir}/CLAUDE.md`
   * - If template CLAUDE.md doesn't exist, return error
   *
   * @param templateName - The template name to copy CLAUDE.md from
   * @param targetDir - The target directory to copy CLAUDE.md to
   * @returns ProjectResult indicating success or failure
   */
  copyClaudeMd(templateName: string, targetDir: string): ProjectResult<void> {
    // Skip if packageDir not configured — instance created without CLAUDE.md
    if (!this.packageDir) {
      return { ok: true, data: undefined };
    }

    const srcPath = path.join(this.packageDir, 'templates', templateName, 'CLAUDE.md');

    // Template CLAUDE.md must exist when packageDir is configured
    if (!fs.existsSync(srcPath)) {
      return { ok: false, error: `模板 CLAUDE.md 不存在: ${srcPath}` };
    }

    try {
      const destPath = path.join(targetDir, 'CLAUDE.md');
      fs.copyFileSync(srcPath, destPath);
      return { ok: true, data: undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `复制 CLAUDE.md 失败: ${message}` };
    }
  }

  // ── Persistence ──

  /**
   * Get the path to the persistence file.
   *
   * @returns The path to projects.json, or undefined if persistDir is not set
   */
  getPersistPath(): string | undefined {
    if (!this.persistDir) {
      return undefined;
    }
    return path.join(this.persistDir, 'projects.json');
  }

  /**
   * Build the current state as a PersistData object.
   *
   * @returns ProjectsPersistData representing current in-memory state
   */
  toPersistData(): ProjectsPersistData {
    const instances: Record<string, PersistedInstance> = {};
    for (const [name, instance] of this.instances) {
      instances[name] = {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      };
    }

    const chatProjectMap: Record<string, string> = {};
    for (const [chatId, name] of this.chatProjectMap) {
      chatProjectMap[chatId] = name;
    }

    return { instances, chatProjectMap };
  }

  /**
   * Persist current state to disk using atomic write-then-rename.
   *
   * Steps:
   * 1. Ensure `.disclaude/` directory exists
   * 2. Write to `projects.json.tmp`
   * 3. Atomically rename `projects.json.tmp` → `projects.json`
   *
   * @returns Error message string on failure, or null on success
   */
  persist(): string | null {
    if (!this.persistDir) {
      return null; // No persist dir configured, skip silently
    }

    const persistPath = path.join(this.persistDir, 'projects.json');
    const tmpPath = `${persistPath}.tmp`;

    try {
      // Ensure directory exists
      fs.mkdirSync(this.persistDir, { recursive: true });

      // Write to tmp file first
      const data = this.toPersistData();
      const json = JSON.stringify(data, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf-8');

      // Atomic rename
      fs.renameSync(tmpPath, persistPath);

      return null;
    } catch (err) {
      // Clean up tmp file on failure
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }

      const message = err instanceof Error ? err.message : String(err);
      return message;
    }
  }

  /**
   * Load persisted data from disk with schema validation.
   *
   * Validates:
   * - File is valid JSON
   * - Has `instances` and `chatProjectMap` fields
   * - Each instance has required fields (name, templateName, workingDir, createdAt)
   * - workingDir is a non-empty string
   * - createdAt is a valid ISO 8601 string
   *
   * @returns ProjectResult with ProjectsPersistData on success, error on failure
   */
  loadPersistedData(): ProjectResult<ProjectsPersistData> {
    const persistPath = this.getPersistPath();
    if (!persistPath) {
      return { ok: false, error: '未配置持久化目录' };
    }

    // Check if file exists
    if (!fs.existsSync(persistPath)) {
      return { ok: false, error: '持久化文件不存在' };
    }

    try {
      const raw = fs.readFileSync(persistPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      // Schema validation
      const validationError = this.validatePersistData(parsed);
      if (validationError) {
        return { ok: false, error: `数据格式错误: ${validationError}` };
      }

      return { ok: true, data: parsed as ProjectsPersistData };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `读取持久化文件失败: ${message}` };
    }
  }

  // ── Accessors (for D phase integration) ──

  /** Get the workspace directory */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  /** Get the package directory */
  getPackageDir(): string {
    return this.packageDir;
  }

  /** Get the persistence directory (undefined if not configured) */
  getPersistDir(): string | undefined {
    return this.persistDir;
  }

  // ── Private Helpers ──

  /**
   * Validate a project/instance name.
   *
   * Rules:
   * - Must be non-empty
   * - Must not be "default" (reserved)
   * - Must not contain ".." (path traversal)
   * - Must not contain "/" or "\" (path separators)
   * - Must not contain null bytes
   * - Must not be whitespace-only
   * - Must not exceed 64 characters
   *
   * @param name - The name to validate
   * @returns Error message string, or null if valid
   */
  private validateName(name: string): string | null {
    if (!name || name.length === 0) {
      return '名称不能为空';
    }
    if (name === 'default') {
      return '"default" 是保留名称';
    }
    if (name.includes('..')) {
      return '名称不能包含 ".."';
    }
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      return '名称不能包含路径分隔符或空字节';
    }
    if (name.trim().length === 0) {
      return '名称不能只包含空白字符';
    }
    if (name.length > MAX_NAME_LENGTH) {
      return `名称长度不能超过 ${MAX_NAME_LENGTH} 个字符`;
    }
    return null;
  }

  /**
   * Validate a chatId.
   *
   * @param chatId - The chatId to validate
   * @returns Error message string, or null if valid
   */
  private validateChatId(chatId: string): string | null {
    if (!chatId || chatId.length === 0) {
      return 'chatId 不能为空';
    }
    return null;
  }

  /**
   * Validate that a working directory path is within workspaceDir.
   *
   * Prevents path traversal attacks by verifying that the resolved
   * working directory is a subdirectory of workspaceDir.
   * Uses path.resolve() to normalize before comparison.
   *
   * @param workingDir - The working directory path to validate
   * @returns Error message string, or null if valid
   */
  private validateWorkingDirPath(workingDir: string): string | null {
    const resolved = path.resolve(workingDir);
    const resolvedWorkspace = path.resolve(this.workspaceDir);

    // workingDir must be inside workspaceDir (strictly, not equal)
    if (
      resolved !== resolvedWorkspace &&
      !resolved.startsWith(resolvedWorkspace + path.sep)
    ) {
      return '工作目录路径超出 workspaceDir 范围';
    }

    return null;
  }

  /**
   * Attempt to persist state to disk. Returns null on success, error string on failure.
   * Skips silently when persistDir is not configured.
   */
  private tryPersist(): string | null {
    if (!this.persistDir) {
      return null;
    }
    return this.persist();
  }

  /**
   * Restore in-memory state from persisted data.
   *
   * Only restores instances whose template still exists in current config.
   * Orphaned instances (template removed) are silently skipped.
   *
   * @param data - Validated persistence data
   */
  private restoreFromPersistData(data: ProjectsPersistData): void {
    // Restore instances
    for (const [name, persisted] of Object.entries(data.instances)) {
      const instance: InternalInstance = {
        name: persisted.name,
        templateName: persisted.templateName,
        workingDir: persisted.workingDir,
        createdAt: persisted.createdAt,
      };
      this.instances.set(name, instance);
    }

    // Restore chatId bindings (only for instances that were restored)
    for (const [chatId, instanceName] of Object.entries(data.chatProjectMap)) {
      if (this.instances.has(instanceName)) {
        this.chatProjectMap.set(chatId, instanceName);
      }
    }
  }

  /**
   * Validate the structure of persisted data.
   *
   * @param data - Parsed JSON data to validate
   * @returns Error message string, or null if valid
   */
  private validatePersistData(data: unknown): string | null {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return '根对象必须是普通对象';
    }

    const obj = data as Record<string, unknown>;

    // Check instances field
    if (typeof obj.instances !== 'object' || obj.instances === null || Array.isArray(obj.instances)) {
      return 'instances 必须是普通对象';
    }

    // Check chatProjectMap field
    if (typeof obj.chatProjectMap !== 'object' || obj.chatProjectMap === null || Array.isArray(obj.chatProjectMap)) {
      return 'chatProjectMap 必须是普通对象';
    }

    // Validate each instance entry
    const instances = obj.instances as Record<string, unknown>;
    for (const [key, value] of Object.entries(instances)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `实例 "${key}" 必须是普通对象`;
      }

      const inst = value as Record<string, unknown>;

      if (typeof inst.name !== 'string' || inst.name.length === 0) {
        return `实例 "${key}" 缺少有效的 name 字段`;
      }
      if (typeof inst.templateName !== 'string' || inst.templateName.length === 0) {
        return `实例 "${key}" 缺少有效的 templateName 字段`;
      }
      if (typeof inst.workingDir !== 'string' || inst.workingDir.length === 0) {
        return `实例 "${key}" 缺少有效的 workingDir 字段`;
      }
      if (typeof inst.createdAt !== 'string' || inst.createdAt.length === 0) {
        return `实例 "${key}" 缺少有效的 createdAt 字段`;
      }

      // Validate createdAt is a valid ISO 8601 date
      const date = new Date(inst.createdAt);
      if (isNaN(date.getTime())) {
        return `实例 "${key}" 的 createdAt 不是有效的日期`;
      }
    }

    // Validate each chatProjectMap entry
    const chatMap = obj.chatProjectMap as Record<string, unknown>;
    for (const [chatId, value] of Object.entries(chatMap)) {
      if (typeof value !== 'string' || value.length === 0) {
        return `绑定 "${chatId}" 的值必须是非空字符串`;
      }
    }

    return null;
  }
}

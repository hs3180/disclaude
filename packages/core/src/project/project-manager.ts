/**
 * ProjectManager — per-chatId working directory binding with template/instance support.
 *
 * Manages chatId → workingDir mappings in memory with atomic persistence.
 * Supports both:
 * - Simplified binding (Issue #3519): direct chatId → path binding via `use(chatId, path)`
 * - Template/Instance model (Issue #1916): `create()` from templates, `use()` by instance name
 *
 * Persistence uses two files (backward-compatible):
 * - `.disclaude/project-bindings.json` (v1): simple bindings, always present
 * - `.disclaude/projects.json` (v2): instances + chatProjectMap, created on first template use
 *
 * @see Issue #3519 (simplify /project command)
 * @see Issue #1916 (parent — unified ProjectContext system)
 */

import {
  writeFileSync, renameSync, unlinkSync, existsSync,
  mkdirSync, readFileSync, copyFileSync,
} from 'node:fs';
import { basename, resolve, join } from 'node:path';
import type {
  CwdProvider,
  InstanceInfo,
  PersistedInstance,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectsPersistData,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Types
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Persistence schema for `.disclaude/project-bindings.json`.
 * Legacy format — kept for backward compatibility.
 */
interface ProjectBindingsData {
  version: number;
  bindings: Record<string, string>;
}

/** Reserved instance name */
const RESERVED_NAME = 'default';

/** Max instance name length */
const MAX_NAME_LENGTH = 64;

/** Allowed characters for instance names: alphanumeric, hyphens, underscores */
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Manages chatId → workingDir bindings with persistence and template/instance support.
 *
 * Lifecycle:
 * 1. Construct with `{ workspaceDir }` (optionally `packageDir` and `projectTemplates`)
 * 2. Bindings and instances loaded from `.disclaude/` automatically
 * 3. Use `use()`, `create()`, `reset()`, `getActive()` to manage bindings
 * 4. Call `createCwdProvider()` to get a CwdProvider for Agent injection
 */
export class ProjectManager {
  private readonly workspaceDir: string;
  private readonly packageDir?: string;
  /** Available templates (from config + package templates) */
  private templates: Map<string, ProjectTemplate> = new Map();
  /** Named instances: instanceName → PersistedInstance */
  private instances: Map<string, PersistedInstance> = new Map();
  /** chatId → instanceName (for template-based binding) */
  private chatProjectMap: Map<string, string> = new Map();
  /** chatId → workingDir (for simple path binding, Issue #3519) */
  private bindings: Map<string, string> = new Map();

  /** Path to .disclaude directory */
  private readonly dataDir: string;
  /** Path to project-bindings.json (legacy) */
  private readonly persistPath: string;
  /** Path to projects.json (template/instance) */
  private readonly projectsPath: string;
  /** Path to temporary file used during atomic write */
  private readonly persistTmpPath: string;
  private readonly projectsTmpPath: string;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir;
    this.dataDir = resolve(options.workspaceDir, '.disclaude');
    this.persistPath = resolve(this.dataDir, 'project-bindings.json');
    this.projectsPath = resolve(this.dataDir, 'projects.json');
    this.persistTmpPath = resolve(this.dataDir, 'project-bindings.json.tmp');
    this.projectsTmpPath = resolve(this.dataDir, 'projects.json.tmp');

    // Load templates from config
    if (options.projectTemplates) {
      for (const [name, config] of Object.entries(options.projectTemplates)) {
        this.templates.set(name, {
          name,
          displayName: config.displayName,
          description: config.description,
        });
      }
    }

    // Restore persisted state
    this.loadPersistedData();
    this.loadProjectsData();
  }

  // ───────────────────────────────────────────
  // Core Methods
  // ───────────────────────────────────────────

  /**
   * Get the active project context for a chatId.
   *
   * Resolution order:
   * 1. Template-based binding (chatProjectMap → instance)
   * 2. Simple path binding (bindings Map)
   * 3. Default (workspace root)
   *
   * @param chatId - Chat session identifier
   * @returns ProjectContextConfig for the active project (or default)
   */
  getActive(chatId: string): ProjectContextConfig {
    // Check template-based binding first
    const projectName = this.chatProjectMap.get(chatId);
    if (projectName) {
      const instance = this.instances.get(projectName);
      if (instance) {
        return {
          name: projectName,
          templateName: instance.templateName,
          workingDir: instance.workingDir,
        };
      }
    }

    // Check simple path binding
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
   * Create a new project instance from a template and bind it to a chatId.
   *
   * - Copies CLAUDE.md from template directory to instance workingDir
   * - Fails if: template doesn't exist, name is reserved, name already exists
   * - Rolls back directory creation on copy failure
   *
   * @param chatId - Chat session requesting creation
   * @param templateName - Template to instantiate
   * @param name - Instance name (user-specified, globally unique)
   * @returns ProjectResult with ProjectContextConfig on success
   */
  create(chatId: string, templateName: string, name: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    const nameError = this.validateInstanceName(name);
    if (nameError) {
      return { ok: false, error: nameError };
    }

    const template = this.templates.get(templateName);
    if (!template) {
      return { ok: false, error: `模板 "${templateName}" 不存在。可用模板: ${this.listTemplateNames()}` };
    }

    if (this.instances.has(name)) {
      return { ok: false, error: `实例 "${name}" 已存在，请使用 /project use ${name} 绑定` };
    }

    // Create instance working directory
    const workingDir = resolve(this.workspaceDir, 'projects', name);

    try {
      mkdirSync(workingDir, { recursive: true });
    } catch (err) {
      return { ok: false, error: `创建工作目录失败: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Copy CLAUDE.md from template
    const copyResult = this.copyClaudeMd(templateName, workingDir);
    if (!copyResult.ok) {
      // Rollback: remove created directory
      try {
        const { rmSync } = require('node:fs');
        rmSync(workingDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
      return { ok: false, error: copyResult.error };
    }

    // Save pre-mutation state for rollback
    const oldProjectName = this.chatProjectMap.get(chatId);
    const oldInstance = this.instances.get(name);

    // Register instance
    const now = new Date().toISOString();
    this.instances.set(name, {
      templateName,
      workingDir,
      createdAt: now,
    });

    // Bind chatId to instance
    this.chatProjectMap.set(chatId, name);

    // Persist
    const persistResult = this.persistProjects();
    if (!persistResult.ok) {
      // Rollback
      if (oldProjectName !== undefined) {
        this.chatProjectMap.set(chatId, oldProjectName);
      } else {
        this.chatProjectMap.delete(chatId);
      }
      if (oldInstance) {
        this.instances.set(name, oldInstance);
      } else {
        this.instances.delete(name);
      }
      return { ok: false, error: persistResult.error };
    }

    return {
      ok: true,
      data: {
        name,
        templateName,
        workingDir,
      },
    };
  }

  /**
   * Bind a chatId to a working directory or an existing instance.
   *
   * Two modes:
   * - If `nameOrPath` matches an existing instance name → bind to instance
   * - Otherwise → treat as a working directory path (simplified mode, Issue #3519)
   *
   * @param chatId - Chat session requesting binding
   * @param nameOrPath - Instance name or working directory path
   * @returns ProjectResult with ProjectContextConfig on success
   */
  use(chatId: string, nameOrPath: string): ProjectResult<ProjectContextConfig> {
    const chatIdError = this.validateChatId(chatId);
    if (chatIdError) {
      return { ok: false, error: chatIdError };
    }

    if (!nameOrPath || nameOrPath.trim().length === 0) {
      return { ok: false, error: '请指定实例名或工作目录路径' };
    }

    // Check if it's an existing instance name
    const instance = this.instances.get(nameOrPath);
    if (instance) {
      return this.useInstance(chatId, nameOrPath, instance);
    }

    // Treat as working directory path (simplified mode)
    return this.usePath(chatId, nameOrPath);
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
    const boundProject = this.chatProjectMap.get(chatId);

    this.bindings.delete(chatId);
    this.chatProjectMap.delete(chatId);

    // Persist both files
    const persistResult = this.persist();
    const projectsResult = this.persistProjects();
    if (!persistResult.ok) {
      // Rollback
      if (boundDir) { this.bindings.set(chatId, boundDir); }
      return { ok: false, error: persistResult.error };
    }
    if (!projectsResult.ok) {
      if (boundProject) { this.chatProjectMap.set(chatId, boundProject); }
      return { ok: false, error: projectsResult.error };
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
   * List all available templates.
   *
   * @returns Array of ProjectTemplate objects
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all project instances (excluding default).
   *
   * @returns Array of InstanceInfo objects
   */
  listInstances(): InstanceInfo[] {
    // Build reverse map: instanceName → chatIds[]
    const instanceChatIds = new Map<string, string[]>();
    for (const [chatId, projectName] of this.chatProjectMap.entries()) {
      const list = instanceChatIds.get(projectName);
      if (list) {
        list.push(chatId);
      } else {
        instanceChatIds.set(projectName, [chatId]);
      }
    }

    const result: InstanceInfo[] = [];
    for (const [name, instance] of this.instances.entries()) {
      result.push({
        name,
        templateName: instance.templateName,
        chatIds: instanceChatIds.get(name) ?? [],
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }
    return result;
  }

  /**
   * List all current simple path bindings.
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
   * Persist simple bindings to disk using atomic write-then-rename.
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
        try { unlinkSync(this.persistTmpPath); } catch { /* Ignore */ }
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
   * Persist projects (instances + chatProjectMap) to disk.
   */
  persistProjects(): ProjectResult<void> {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      const data: ProjectsPersistData = {
        version: 2,
        instances: {},
        chatProjectMap: {},
      };

      for (const [name, instance] of this.instances.entries()) {
        data.instances[name] = instance;
      }
      for (const [chatId, projectName] of this.chatProjectMap.entries()) {
        data.chatProjectMap[chatId] = projectName;
      }

      const json = JSON.stringify(data, null, 2);
      writeFileSync(this.projectsTmpPath, json, 'utf8');

      try {
        renameSync(this.projectsTmpPath, this.projectsPath);
      } catch (renameErr) {
        try { unlinkSync(this.projectsTmpPath); } catch { /* Ignore */ }
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
   * Load persisted bindings from disk (legacy format).
   *
   * Gracefully handles missing/corrupted files.
   */
  loadPersistedData(): ProjectResult<void> {
    if (!existsSync(this.persistPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validatePersistSchema(data)) {
        return { ok: false, error: 'project-bindings.json 格式无效，已跳过恢复' };
      }

      const persisted = data as ProjectBindingsData;

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
   * Load persisted projects (instances + chatProjectMap) from disk.
   *
   * Gracefully handles missing/corrupted files.
   */
  loadProjectsData(): ProjectResult<void> {
    if (!existsSync(this.projectsPath)) {
      return { ok: true, data: undefined };
    }

    try {
      const raw = readFileSync(this.projectsPath, 'utf8');
      const data = JSON.parse(raw) as unknown;

      if (!this.validateProjectsSchema(data)) {
        return { ok: false, error: 'projects.json 格式无效，已跳过恢复' };
      }

      const persisted = data as ProjectsPersistData;

      // Restore instances
      for (const [name, instance] of Object.entries(persisted.instances)) {
        if (this.isValidPersistedInstance(instance)) {
          this.instances.set(name, instance);
        }
      }

      // Restore chatProjectMap
      for (const [chatId, projectName] of Object.entries(persisted.chatProjectMap)) {
        if (typeof projectName === 'string' && projectName.length > 0) {
          this.chatProjectMap.set(chatId, projectName);
        }
      }

      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `读取 projects.json 失败: ${err instanceof Error ? err.message : String(err)}`,
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
   * Get the projects file path (for testing/debugging).
   */
  getProjectsPath(): string {
    return this.projectsPath;
  }

  /**
   * Get the workspace directory (for testing/debugging).
   */
  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  // ───────────────────────────────────────────
  // Internal: Binding Helpers
  // ───────────────────────────────────────────

  /**
   * Bind chatId to an existing instance by name.
   */
  private useInstance(
    chatId: string,
    name: string,
    instance: PersistedInstance,
  ): ProjectResult<ProjectContextConfig> {
    const oldProjectName = this.chatProjectMap.get(chatId);

    this.chatProjectMap.set(chatId, name);

    const persistResult = this.persistProjects();
    if (!persistResult.ok) {
      // Rollback
      if (oldProjectName !== undefined) {
        this.chatProjectMap.set(chatId, oldProjectName);
      } else {
        this.chatProjectMap.delete(chatId);
      }
      return { ok: false, error: persistResult.error };
    }

    return {
      ok: true,
      data: {
        name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
      },
    };
  }

  /**
   * Bind chatId to a working directory path (simplified mode, Issue #3519).
   */
  private usePath(chatId: string, workingDir: string): ProjectResult<ProjectContextConfig> {
    const dirError = this.validateWorkingDir(workingDir);
    if (dirError) {
      return { ok: false, error: dirError };
    }

    const resolvedDir = resolve(this.workspaceDir, workingDir);

    // Save pre-mutation state for rollback
    const oldDir = this.bindings.get(chatId);

    this.bindings.set(chatId, resolvedDir);

    const persistResult = this.persist();
    if (!persistResult.ok) {
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

  // ───────────────────────────────────────────
  // Internal: Template Helpers
  // ───────────────────────────────────────────

  /**
   * Copy CLAUDE.md from a template directory to the target directory.
   */
  private copyClaudeMd(templateName: string, targetDir: string): ProjectResult<void> {
    if (!this.packageDir) {
      return { ok: false, error: '未配置 packageDir，无法复制模板文件' };
    }

    const sourcePath = join(this.packageDir, 'templates', templateName, 'CLAUDE.md');

    if (!existsSync(sourcePath)) {
      return { ok: false, error: `模板 CLAUDE.md 不存在: ${sourcePath}` };
    }

    try {
      copyFileSync(sourcePath, join(targetDir, 'CLAUDE.md'));
      return { ok: true, data: undefined };
    } catch (err) {
      return {
        ok: false,
        error: `复制 CLAUDE.md 失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Get comma-separated list of available template names.
   */
  private listTemplateNames(): string {
    const names = Array.from(this.templates.keys());
    return names.length > 0 ? names.join(', ') : '(无)';
  }

  // ───────────────────────────────────────────
  // Internal: Validation
  // ───────────────────────────────────────────

  /**
   * Validate the top-level schema of legacy persisted data.
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
   * Validate the top-level schema of projects data.
   */
  private validateProjectsSchema(data: unknown): data is ProjectsPersistData {
    if (typeof data !== 'object' || data === null) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    if (obj.version !== 2) {
      return false;
    }
    if (typeof obj.instances !== 'object' || obj.instances === null || Array.isArray(obj.instances)) {
      return false;
    }
    if (typeof obj.chatProjectMap !== 'object' || obj.chatProjectMap === null || Array.isArray(obj.chatProjectMap)) {
      return false;
    }
    return true;
  }

  /**
   * Check if a value is a valid PersistedInstance.
   */
  private isValidPersistedInstance(value: unknown): value is PersistedInstance {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const obj = value as Record<string, unknown>;
    return (
      typeof obj.templateName === 'string' &&
      typeof obj.workingDir === 'string' &&
      typeof obj.createdAt === 'string'
    );
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

  /**
   * Validate an instance name.
   */
  private validateInstanceName(name: string): string | null {
    if (!name || name.trim().length === 0) {
      return '实例名不能为空';
    }

    if (name === RESERVED_NAME) {
      return `"${RESERVED_NAME}" 为保留名，请使用其他名称`;
    }

    if (name.length > MAX_NAME_LENGTH) {
      return `实例名过长（最大 ${MAX_NAME_LENGTH} 字符）`;
    }

    if (!NAME_PATTERN.test(name)) {
      return '实例名只能包含字母、数字、连字符和下划线';
    }

    return null;
  }
}

/**
 * ProjectManager — core logic for unified per-chatId Agent context switching.
 *
 * In-memory operations with optional persistence via projects.json.
 * Persistence is handled by Sub-Issue C (#2225), filesystem by Sub-Issue D (#2226).
 *
 * @see docs/proposals/unified-project-context.md §4 API Design
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — Persistence)
 * @see Issue #1916 (parent)
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
// Constants
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Subdirectory under workspace for project instances */
const PROJECTS_DIR_NAME = 'projects';

/** Reserved name — always implicitly available as workspace root */
const RESERVED_NAME = 'default';

/** Maximum allowed length for instance names */
const MAX_NAME_LENGTH = 64;

/** Characters forbidden in instance names (path traversal + injection risks) */
const FORBIDDEN_NAME_CHARS = /[\x00\\/]/;

/** Directory name under workspace for persistence metadata */
const DISCLAUDE_DIR_NAME = '.disclaude';

/** Filename for persisted project data */
const PROJECTS_FILENAME = 'projects.json';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Internal Instance Shape
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

interface InternalInstance {
  name: string;
  templateName: string;
  workingDir: string;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Core ProjectManager — manages per-chatId project bindings in memory.
 *
 * Lifecycle:
 * 1. `new ProjectManager(options)` — construct with workspace/package/config paths
 * 2. `init()` — load templates from config
 * 3. Use `create`/`use`/`reset`/`getActive` for runtime operations
 *
 * Thread safety: NOT thread-safe. Designed for single-process, single-thread use.
 */
export class ProjectManager {
  private templates: Map<string, ProjectTemplate>;
  private instances: Map<string, InternalInstance>;
  private chatProjectMap: Map<string, string>; // chatId → instanceName
  private readonly workspaceDir: string;

  constructor(options: ProjectManagerOptions) {
    this.workspaceDir = options.workspaceDir;
    // Note: options.packageDir is stored for Sub-Issue D (filesystem operations)
    // but not needed in Sub-Issue C (persistence only)
    this.templates = new Map();
    this.instances = new Map();
    this.chatProjectMap = new Map();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Initialization
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Initialize ProjectManager by loading templates from config.
   *
   * May be called multiple times — subsequent calls replace all templates.
   * If no config provided, uses the one from constructor options.
   */
  init(templatesConfig?: ProjectTemplatesConfig): void {
    const config = templatesConfig ?? {};
    this.templates.clear();

    for (const [name, meta] of Object.entries(config)) {
      this.templates.set(name, {
        name,
        displayName: meta.displayName,
        description: meta.description,
      });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Core Methods
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get the active project for a chatId.
   *
   * - If bound to an existing instance → return that instance's config
   * - If bound to a non-existent instance (stale binding) → auto-heal: remove binding, return default
   * - If not bound → return default project
   *
   * Always returns a valid ProjectContextConfig (never throws).
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
      // Stale binding: instance was removed externally → self-heal
      this.chatProjectMap.delete(chatId);
      // Best-effort persist for self-healing (failure shouldn't block getActive)
      this.persist();
    }

    return this.getDefaultProject();
  }

  /**
   * Create a new project instance from a template and bind it to the chatId.
   *
   * Validation:
   * - `name` must not be "default" (reserved)
   * - `name` must not contain "..", "/", "\", null bytes
   * - `name` must be non-empty and ≤ 64 chars
   * - `templateName` must exist in loaded templates
   * - `name` must not already exist as an instance
   * - `chatId` must be non-empty
   */
  create(
    chatId: string,
    templateName: string,
    name: string,
  ): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdResult = this.validateChatId(chatId);
    if (!chatIdResult.ok) return chatIdResult as ProjectResult<ProjectContextConfig>;

    // Validate name
    const nameResult = this.validateName(name);
    if (!nameResult.ok) return nameResult as ProjectResult<ProjectContextConfig>;

    // Validate templateName
    const templateResult = this.validateTemplateName(templateName);
    if (!templateResult.ok) return templateResult as ProjectResult<ProjectContextConfig>;

    // Check for duplicate instance name
    if (this.instances.has(name)) {
      return {
        ok: false,
        error: `实例名 "${name}" 已存在，请使用 /project use 绑定`,
      };
    }

    // Create instance in memory
    const workingDir = path.join(
      this.workspaceDir,
      PROJECTS_DIR_NAME,
      name,
    );

    const instance: InternalInstance = {
      name,
      templateName,
      workingDir,
      createdAt: new Date().toISOString(),
    };

    this.instances.set(name, instance);
    this.chatProjectMap.set(chatId, name);

    // Persist — rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback memory state
      this.instances.delete(name);
      this.chatProjectMap.delete(chatId);
      return {
        ok: false,
        error: persistResult.error,
      };
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
   * "default" is reserved — use `reset()` to return to default.
   */
  use(chatId: string, name: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdResult = this.validateChatId(chatId);
    if (!chatIdResult.ok) return chatIdResult as ProjectResult<ProjectContextConfig>;

    // "default" is reserved — use reset() instead (check before validateName for helpful message)
    if (name === RESERVED_NAME) {
      return {
        ok: false,
        error: `"default" 是保留名，请使用 /project reset 回到默认项目`,
      };
    }

    // Validate name
    const nameResult = this.validateName(name);
    if (!nameResult.ok) return nameResult as ProjectResult<ProjectContextConfig>;

    // Check instance exists
    const instance = this.instances.get(name);
    if (!instance) {
      return {
        ok: false,
        error: `实例 "${name}" 不存在，请使用 /project create 创建`,
      };
    }

    // Bind
    const prevBinding = this.chatProjectMap.get(chatId);
    this.chatProjectMap.set(chatId, name);

    // Persist — rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback to previous state
      if (prevBinding !== undefined) {
        this.chatProjectMap.set(chatId, prevBinding);
      } else {
        this.chatProjectMap.delete(chatId);
      }
      return {
        ok: false,
        error: persistResult.error,
      };
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
   * Reset a chatId back to the default project.
   *
   * Silent no-op if the chatId is already on default (no binding).
   */
  reset(chatId: string): ProjectResult<ProjectContextConfig> {
    // Validate chatId
    const chatIdResult = this.validateChatId(chatId);
    if (!chatIdResult.ok) return chatIdResult as ProjectResult<ProjectContextConfig>;

    // Capture previous binding for rollback
    const prevBinding = this.chatProjectMap.get(chatId);

    // Remove binding if exists (silent no-op if not bound)
    this.chatProjectMap.delete(chatId);

    // Persist — rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback
      if (prevBinding !== undefined) {
        this.chatProjectMap.set(chatId, prevBinding);
      }
      return persistResult as ProjectResult<ProjectContextConfig>;
    }

    return {
      ok: true,
      data: this.getDefaultProject(),
    };
  }

  /**
   * List all available templates.
   *
   * Returns templates loaded from config during `init()`.
   */
  listTemplates(): ProjectTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * List all project instances (excluding default).
   *
   * Each instance includes its bound chatIds and binding count.
   */
  listInstances(): InstanceInfo[] {
    // Build reverse map: instanceName → chatIds[]
    const bindingMap = new Map<string, string[]>();
    for (const [chatId, instanceName] of this.chatProjectMap.entries()) {
      const bindings = bindingMap.get(instanceName);
      if (bindings) {
        bindings.push(chatId);
      } else {
        bindingMap.set(instanceName, [chatId]);
      }
    }

    const result: InstanceInfo[] = [];
    for (const instance of this.instances.values()) {
      result.push({
        name: instance.name,
        templateName: instance.templateName,
        chatIds: bindingMap.get(instance.name) ?? [],
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      });
    }

    return result;
  }

  /**
   * Create a CwdProvider closure for injection into Pilot/Agent.
   *
   * The provider returns the workingDir for the chatId's active project,
   * or `undefined` for the default project (SDK falls back to getWorkspaceDir()).
   */
  createCwdProvider(): CwdProvider {
    return (chatId: string): string | undefined => {
      const active = this.getActive(chatId);
      // Default project → return undefined to let SDK use workspaceDir
      if (active.name === RESERVED_NAME) {
        return undefined;
      }
      return active.workingDir;
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Persistence Methods
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Load persisted state from projects.json.
   *
   * Restores instances and chatProjectMap from the persistence file.
   * Should be called during initialization after `init()`.
   *
   * - If file doesn't exist → silently succeeds (fresh start)
   * - If file is corrupted → returns error (does not crash)
   * - Schema validation: workingDir must be string, createdAt must exist
   */
  loadPersistedData(): ProjectResult<void> {
    const filePath = this.getPersistencePath();

    if (!fs.existsSync(filePath)) {
      return { ok: true, data: undefined };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content) as ProjectsPersistData;

      // Schema validation
      if (typeof data.instances !== 'object' || data.instances === null) {
        return {
          ok: false,
          error: 'projects.json 格式损坏: instances 必须是对象',
        };
      }
      if (typeof data.chatProjectMap !== 'object' || data.chatProjectMap === null) {
        return {
          ok: false,
          error: 'projects.json 格式损坏: chatProjectMap 必须是对象',
        };
      }

      // Validate each instance entry
      for (const [name, instance] of Object.entries(data.instances)) {
        if (typeof instance.workingDir !== 'string') {
          return {
            ok: false,
            error: `实例 "${name}" 的 workingDir 无效`,
          };
        }
        if (!instance.createdAt || typeof instance.createdAt !== 'string') {
          return {
            ok: false,
            error: `实例 "${name}" 缺少有效的 createdAt`,
          };
        }
      }

      // Restore state — clear first to avoid stale data
      this.instances.clear();
      this.chatProjectMap.clear();

      for (const [name, instance] of Object.entries(data.instances)) {
        this.instances.set(name, {
          name: instance.name,
          templateName: instance.templateName,
          workingDir: instance.workingDir,
          createdAt: instance.createdAt,
        });
      }

      for (const [chatId, instanceName] of Object.entries(data.chatProjectMap)) {
        this.chatProjectMap.set(chatId, instanceName);
      }

      return { ok: true, data: undefined };
    } catch (err) {
      if (err instanceof SyntaxError) {
        return {
          ok: false,
          error: `projects.json 解析失败: ${err.message}`,
        };
      }
      return {
        ok: false,
        error: `加载持久化数据失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * Delete a project instance by name.
   *
   * Removes the instance from memory and all associated chatId bindings.
   * Persists the change to disk. On persist failure, rolls back memory state.
   *
   * Note: This only removes metadata. Working directory cleanup is
   * handled by Sub-Issue D (#2226).
   */
  delete(name: string): ProjectResult<void> {
    // Validate name
    const nameResult = this.validateName(name);
    if (!nameResult.ok) return nameResult;

    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // Capture state for rollback
    const removedBindings: Array<[string, string]> = [];
    for (const [cid, instName] of this.chatProjectMap.entries()) {
      if (instName === name) {
        removedBindings.push([cid, instName]);
        this.chatProjectMap.delete(cid);
      }
    }

    // Remove instance from memory
    this.instances.delete(name);

    // Persist — rollback on failure
    const persistResult = this.persist();
    if (!persistResult.ok) {
      // Rollback: restore instance and bindings
      this.instances.set(name, instance);
      for (const [cid, instName] of removedBindings) {
        this.chatProjectMap.set(cid, instName);
      }
      return persistResult;
    }

    return { ok: true, data: undefined };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Private Helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Get the default project config.
   */
  private getDefaultProject(): ProjectContextConfig {
    return {
      name: RESERVED_NAME,
      workingDir: this.workspaceDir,
    };
  }

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
   */
  private validateName(name: string): ProjectResult<void> {
    if (!name || name.length === 0) {
      return { ok: false, error: '实例名不能为空' };
    }

    if (name === RESERVED_NAME) {
      return { ok: false, error: `"${RESERVED_NAME}" 是保留名，不可使用` };
    }

    if (name === '..') {
      return { ok: false, error: '实例名不能为 ".."' };
    }

    // Check for path traversal: any ".." segment in the name
    if (name.includes('..')) {
      return { ok: false, error: '实例名不能包含 ".."' };
    }

    // Check for forbidden characters (path separators + null byte)
    if (FORBIDDEN_NAME_CHARS.test(name)) {
      return { ok: false, error: '实例名不能包含 /、\\ 或空字节' };
    }

    // Check for whitespace-only names
    if (name.trim().length === 0) {
      return { ok: false, error: '实例名不能为纯空白字符' };
    }

    // Length limit
    if (name.length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        error: `实例名长度不能超过 ${MAX_NAME_LENGTH} 个字符`,
      };
    }

    return { ok: true, data: undefined };
  }

  /**
   * Validate a chatId.
   *
   * Rules:
   * - Must be non-empty
   */
  private validateChatId(chatId: string): ProjectResult<void> {
    if (!chatId || chatId.length === 0) {
      return { ok: false, error: 'chatId 不能为空' };
    }
    return { ok: true, data: undefined };
  }

  /**
   * Validate a template name against loaded templates.
   *
   * Rules:
   * - Must exist in the templates map
   */
  private validateTemplateName(templateName: string): ProjectResult<void> {
    if (!this.templates.has(templateName)) {
      return {
        ok: false,
        error: `模板 "${templateName}" 不存在，可用模板: ${this.getTemplateNamesList()}`,
      };
    }
    return { ok: true, data: undefined };
  }

  /**
   * Get a comma-separated list of available template names for error messages.
   */
  private getTemplateNamesList(): string {
    const names = Array.from(this.templates.keys());
    if (names.length === 0) return '(无可用模板)';
    return names.join(', ');
  }

  /**
   * Get the full path to the persistence file.
   */
  private getPersistencePath(): string {
    return path.join(this.workspaceDir, DISCLAUDE_DIR_NAME, PROJECTS_FILENAME);
  }

  /**
   * Persist current state to projects.json atomically.
   *
   * Uses write-to-temp + rename pattern to prevent corruption on crash.
   * Creates .disclaude/ directory if it doesn't exist.
   *
   * Returns error if write fails (caller should rollback memory state).
   */
  private persist(): ProjectResult<void> {
    const data: ProjectsPersistData = {
      instances: {},
      chatProjectMap: Object.fromEntries(this.chatProjectMap),
    };

    for (const [name, instance] of this.instances) {
      data.instances[name] = {
        name: instance.name,
        templateName: instance.templateName,
        workingDir: instance.workingDir,
        createdAt: instance.createdAt,
      } satisfies PersistedInstance;
    }

    const filePath = this.getPersistencePath();
    const disclaudeDir = path.dirname(filePath);
    const tmpPath = filePath + '.tmp';

    try {
      // Ensure .disclaude directory exists
      if (!fs.existsSync(disclaudeDir)) {
        fs.mkdirSync(disclaudeDir, { recursive: true });
      }

      // Write to temp file first
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');

      // Atomic rename
      fs.renameSync(tmpPath, filePath);

      return { ok: true, data: undefined };
    } catch (err) {
      // Clean up temp file on failure
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup errors — original error is more important
      }

      return {
        ok: false,
        error: `持久化失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

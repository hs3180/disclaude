/**
 * ProjectManager — core logic for unified per-chatId Agent context switching.
 *
 * Pure in-memory operations. No filesystem or persistence dependencies.
 * Persistence is handled by Sub-Issue C (#2225), filesystem by Sub-Issue D (#2226).
 *
 * @see docs/proposals/unified-project-context.md §4 API Design
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #1916 (parent)
 */

import path from 'node:path';
import type {
  CwdProvider,
  InstanceInfo,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
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
    // but not needed in pure-memory Phase B
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
    this.chatProjectMap.set(chatId, name);

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

    // Remove binding if exists (silent no-op if not bound)
    this.chatProjectMap.delete(chatId);

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
}

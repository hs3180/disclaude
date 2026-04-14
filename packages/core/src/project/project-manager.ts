/**
 * ProjectManager — core logic for unified per-chatId Agent context switching.
 *
 * In-memory operations with filesystem support for working directory creation
 * and CLAUDE.md template copying.
 * Persistence is handled by Sub-Issue C (#2225).
 *
 * @see docs/proposals/unified-project-context.md §4 API Design
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2226 (Sub-Issue D — Filesystem operations)
 * @see Issue #1916 (parent)
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import type {
  CwdProvider,
  InstanceInfo,
  ProjectContextConfig,
  ProjectManagerOptions,
  ProjectResult,
  ProjectTemplate,
  ProjectTemplatesConfig,
} from './types.js';

const logger = createLogger('ProjectManager');

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

/** Name of the template instruction file */
const CLAUDE_MD_FILENAME = 'CLAUDE.md';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Filesystem Adapter (injectable for testing)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Filesystem operations interface used by ProjectManager.
 *
 * In production, this is backed by `node:fs`.
 * In tests, a mock implementation can be injected to test pure in-memory behavior.
 *
 * @see Issue #2226 (Sub-Issue D — Filesystem operations)
 */
export interface FilesystemOps {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  copyFileSync(src: string, dest: string): void;
  rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
}

/**
 * No-op filesystem adapter for pure in-memory testing.
 *
 * All operations succeed without touching the real filesystem.
 * `existsSync` returns `true` so that template copy checks pass.
 * Used by Sub-Issue B tests to maintain pure in-memory behavior.
 */
export const noOpFs: FilesystemOps = {
  existsSync: () => true,
  mkdirSync: () => {},
  copyFileSync: () => {},
  rmSync: () => {},
};

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
  private readonly packageDir: string;
  private readonly fsOps: FilesystemOps;

  constructor(options: ProjectManagerOptions, fsOps?: FilesystemOps) {
    this.workspaceDir = options.workspaceDir;
    this.packageDir = options.packageDir;
    this.fsOps = fsOps ?? fs;
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
   * If no config provided, uses an empty config (no templates).
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
   * After in-memory creation, calls `instantiateFromTemplate()` to create
   * the working directory and copy CLAUDE.md from the template.
   *
   * If filesystem operations fail, the in-memory instance is rolled back
   * and an error is returned.
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
    if (!chatIdResult.ok) {return chatIdResult as ProjectResult<ProjectContextConfig>;}

    // Validate name
    const nameResult = this.validateName(name);
    if (!nameResult.ok) {return nameResult as ProjectResult<ProjectContextConfig>;}

    // Validate templateName
    const templateResult = this.validateTemplateName(templateName);
    if (!templateResult.ok) {return templateResult as ProjectResult<ProjectContextConfig>;}

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

    // Filesystem: create working directory and copy CLAUDE.md
    const fsResult = this.instantiateFromTemplate(name);
    if (!fsResult.ok) {
      // Rollback in-memory state on filesystem failure
      this.instances.delete(name);
      this.chatProjectMap.delete(chatId);
      return { ok: false, error: fsResult.error };
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
    if (!chatIdResult.ok) {return chatIdResult as ProjectResult<ProjectContextConfig>;}

    // "default" is reserved — use reset() instead
    if (name === RESERVED_NAME) {
      return {
        ok: false,
        error: '"default" 是保留名，请使用 /project reset 回到默认项目',
      };
    }

    // Validate name
    const nameResult = this.validateName(name);
    if (!nameResult.ok) {return nameResult as ProjectResult<ProjectContextConfig>;}

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
    if (!chatIdResult.ok) {return chatIdResult as ProjectResult<ProjectContextConfig>;}

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
  // Filesystem Operations (Sub-Issue D #2226)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Create the working directory and copy CLAUDE.md from the template.
   *
   * This method is called by `create()` after the in-memory instance is set up.
   * It performs the following filesystem operations:
   * 1. Validates the resolved path is within workspaceDir (path traversal protection)
   * 2. Creates the working directory `{workspaceDir}/projects/{name}/`
   * 3. Copies CLAUDE.md from `{packageDir}/templates/{templateName}/CLAUDE.md`
   *    (skipped if packageDir is not configured or template CLAUDE.md doesn't exist)
   * 4. On CLAUDE.md copy failure, rolls back by removing the created directory
   *
   * @param name - Instance name (already validated by `create()`)
   * @returns Success or error
   */
  instantiateFromTemplate(name: string): ProjectResult<void> {
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    const { workingDir } = instance;

    // Path traversal protection: verify resolved path is within workspaceDir
    const resolvedWorkingDir = path.resolve(workingDir);
    const resolvedWorkspaceDir = path.resolve(this.workspaceDir);
    if (!resolvedWorkingDir.startsWith(resolvedWorkspaceDir + path.sep) &&
        resolvedWorkingDir !== resolvedWorkspaceDir) {
      return {
        ok: false,
        error: `路径遍历攻击被阻止: "${name}" 解析到 "${resolvedWorkingDir}"，不在工作空间 "${resolvedWorkspaceDir}" 内`,
      };
    }

    // Create working directory
    try {
      if (!this.fsOps.existsSync(workingDir)) {
        this.fsOps.mkdirSync(workingDir, { recursive: true });
        logger.debug({ dir: workingDir }, 'Created project working directory');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `无法创建工作目录 "${workingDir}": ${message}` };
    }

    // Copy CLAUDE.md from template
    const copyResult = this.copyClaudeMd(name);
    if (!copyResult.ok) {
      // Rollback: remove created directory on copy failure
      try {
        if (this.fsOps.existsSync(workingDir)) {
          this.fsOps.rmSync(workingDir, { recursive: true, force: true });
          logger.debug({ dir: workingDir }, 'Rolled back working directory after CLAUDE.md copy failure');
        }
      } catch (rollbackError) {
        const msg = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        logger.error({ dir: workingDir, error: msg }, 'Failed to rollback working directory');
      }
      return copyResult;
    }

    return { ok: true, data: undefined };
  }

  /**
   * Copy CLAUDE.md from the template directory to the instance working directory.
   *
   * - If `packageDir` is not configured (empty string), skip copy (instance has no CLAUDE.md)
   * - If the template CLAUDE.md doesn't exist, return an error
   * - On copy success, the instance working directory contains CLAUDE.md
   *
   * @param name - Instance name (must exist in instances map)
   * @returns Success or error
   */
  copyClaudeMd(name: string): ProjectResult<void> {
    const instance = this.instances.get(name);
    if (!instance) {
      return { ok: false, error: `实例 "${name}" 不存在` };
    }

    // If packageDir is not configured, skip CLAUDE.md copy (instance still valid)
    if (!this.packageDir) {
      logger.debug({ name }, 'No packageDir configured, skipping CLAUDE.md copy');
      return { ok: true, data: undefined };
    }

    const sourcePath = path.join(
      this.packageDir,
      'templates',
      instance.templateName,
      CLAUDE_MD_FILENAME,
    );
    const destPath = path.join(instance.workingDir, CLAUDE_MD_FILENAME);

    // Check if template CLAUDE.md exists
    if (!this.fsOps.existsSync(sourcePath)) {
      return {
        ok: false,
        error: `模板文件不存在: "${sourcePath}"`,
      };
    }

    // Copy CLAUDE.md
    try {
      this.fsOps.copyFileSync(sourcePath, destPath);
      logger.debug({ from: sourcePath, to: destPath }, 'Copied CLAUDE.md to instance');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `无法复制 CLAUDE.md: ${message}` };
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
    if (names.length === 0) {return '(无可用模板)';}
    return names.join(', ');
  }
}

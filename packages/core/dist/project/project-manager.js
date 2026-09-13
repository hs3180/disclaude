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
import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readFileSync, } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('ProjectManager');
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
    workspaceDir;
    /** chatId → workingDir binding */
    bindings = new Map();
    /** Path to .disclaude directory */
    dataDir;
    /** Path to project-bindings.json */
    persistPath;
    /** Path to temporary file used during atomic write */
    persistTmpPath;
    constructor(options) {
        this.workspaceDir = options.workspaceDir;
        this.dataDir = resolve(options.workspaceDir, '.disclaude');
        this.persistPath = resolve(this.dataDir, 'project-bindings.json');
        this.persistTmpPath = resolve(this.dataDir, 'project-bindings.json.tmp');
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
    getActive(chatId) {
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
    use(chatId, workingDir) {
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
            }
            else {
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
    reset(chatId) {
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
    listBindings() {
        return Array.from(this.bindings.entries()).map(([chatId, workingDir]) => ({
            chatId,
            workingDir,
        }));
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
    resolveCwd(chatId) {
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
    createCwdProvider() {
        return (chatId) => {
            const resolution = this.resolveCwd(chatId);
            if (resolution.reason === 'bound-missing') {
                logger.warn({ chatId, workingDir: resolution.boundWorkingDir }, 'Bound project directory does not exist, falling back to workspace');
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
    persist() {
        try {
            // Ensure .disclaude/ directory exists
            if (!existsSync(this.dataDir)) {
                mkdirSync(this.dataDir, { recursive: true });
            }
            const data = {
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
            }
            catch (renameErr) {
                // Clean up .tmp file if rename fails
                try {
                    unlinkSync(this.persistTmpPath);
                }
                catch {
                    // Ignore cleanup failure
                }
                return {
                    ok: false,
                    error: `持久化写入失败: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
                };
            }
            return { ok: true, data: undefined };
        }
        catch (err) {
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
    loadPersistedData() {
        if (!existsSync(this.persistPath)) {
            // First run — no persisted data
            return { ok: true, data: undefined };
        }
        try {
            const raw = readFileSync(this.persistPath, 'utf8');
            const data = JSON.parse(raw);
            if (!this.validatePersistSchema(data)) {
                return { ok: false, error: 'project-bindings.json 格式无效，已跳过恢复' };
            }
            const persisted = data;
            // Restore bindings
            for (const [chatId, workingDir] of Object.entries(persisted.bindings)) {
                if (typeof workingDir === 'string' && workingDir.length > 0) {
                    this.bindings.set(chatId, workingDir);
                }
            }
            return { ok: true, data: undefined };
        }
        catch (err) {
            return {
                ok: false,
                error: `读取 project-bindings.json 失败: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    /**
     * Get the persist file path (for testing/debugging).
     */
    getPersistPath() {
        return this.persistPath;
    }
    /**
     * Get the workspace directory (for testing/debugging).
     */
    getWorkspaceDir() {
        return this.workspaceDir;
    }
    // ───────────────────────────────────────────
    // Internal Helpers
    // ───────────────────────────────────────────
    /**
     * Validate the top-level schema of persisted data.
     */
    validatePersistSchema(data) {
        if (typeof data !== 'object' || data === null) {
            return false;
        }
        const obj = data;
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
    validateChatId(chatId) {
        if (!chatId || chatId.length === 0) {
            return 'chatId 不能为空';
        }
        return null;
    }
    /**
     * Validate a working directory path.
     */
    validateWorkingDir(workingDir) {
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

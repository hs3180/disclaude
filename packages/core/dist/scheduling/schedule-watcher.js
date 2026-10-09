/**
 * Schedule Watcher - Scans and watches schedule markdown files.
 *
 * This module combines:
 * - ScheduleFileScanner: Scans and parses schedule markdown files
 * - ScheduleFileWatcher: Hot reload for schedule files
 *
 * ## File Format
 *
 * ```markdown
 * ---
 * name: Daily Report
 * cron: "0 9 * * *"
 * enabled: true
 * blocking: true
 * chatId: oc_xxx
 * createdBy: ou_xxx
 * ---
 *
 * Task prompt content here...
 * ```
 *
 * Issue #1041: Migrated from @disclaude/worker-node to @disclaude/core.
 *
 * @module @disclaude/core/scheduling
 */
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('ScheduleWatcher');
// ============================================================================
// Shared Utility Functions
// ============================================================================
/**
 * Parse YAML frontmatter from schedule content.
 */
function parseScheduleFrontmatter(content) {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
    const match = content.match(frontmatterRegex);
    if (!match) {
        return { frontmatter: {}, contentStart: 0, unknownKeys: [] };
    }
    const [, frontmatterText] = match;
    const parsed = yaml.load(frontmatterText, { schema: yaml.JSON_SCHEMA });
    if (parsed === undefined || parsed === null) {
        return { frontmatter: {}, contentStart: match[0].length, unknownKeys: [] };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Schedule frontmatter must be a YAML mapping');
    }
    const frontmatter = {};
    const unknownKeys = [];
    for (const [key, value] of Object.entries(parsed)) {
        switch (key) {
            case 'modelTier':
                throw new ScheduleFileParseError('removed-field', 'modelTier was removed; set an explicit model field instead.');
            case 'script':
                throw new ScheduleFileParseError('renamed-field', 'script was renamed to command; update the frontmatter.');
            case 'name':
            case 'cron':
            case 'chatId':
            case 'createdBy':
            case 'createdAt':
            case 'lastExecutedAt':
            case 'model':
            case 'timezone':
            case 'command':
                // The old line parser exposed every scalar as text. Keep that behavior
                // for supported string fields while letting YAML remove valid comments.
                frontmatter[key] = value === null ? '' : String(value);
                break;
            case 'enabled':
            case 'blocking':
                if (typeof value !== 'boolean') {
                    throw new ScheduleFileParseError('invalid-boolean', `${key} must be true or false.`);
                }
                frontmatter[key] = value;
                break;
            case 'clearContext':
            case 'freshSession':
            case 'skipHistory':
                frontmatter[key] = value;
                break;
            case 'cooldownPeriod':
            case 'timeoutMs':
                if ((typeof value !== 'number' && typeof value !== 'string')
                    || (typeof value === 'string' && !/^\d+$/.test(value))
                    || !Number.isSafeInteger(Number(value))) {
                    throw new ScheduleFileParseError('invalid-number', `${key} must be a non-negative integer.`);
                }
                frontmatter[key] = Number(value);
                break;
            default:
                unknownKeys.push(/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(key) ? key : '<non-standard key>');
        }
    }
    return { frontmatter, contentStart: match[0].length, unknownKeys: unknownKeys.sort() };
}
class ScheduleFileParseError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ScheduleFileParseError';
    }
}
function isSafeChatId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(value);
}
function recoverChatId(frontmatterText) {
    const match = frontmatterText.match(/^chatId\s*:\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))\s*(?:#.*)?$/m);
    const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
    return isSafeChatId(candidate) ? candidate : undefined;
}
function yamlErrorLocation(error) {
    if (typeof error !== 'object' || error === null || !('mark' in error)) {
        return {};
    }
    const { mark } = error;
    if (!mark) {
        return {};
    }
    return {
        // Frontmatter starts on line 2 of SCHEDULE.md, after the opening `---`.
        ...(typeof mark.line === 'number' && { line: mark.line + 2 }),
        ...(typeof mark.column === 'number' && { column: mark.column + 1 }),
    };
}
/**
 * Generate task ID from file path.
 *
 * Expects the subdirectory layout: `schedules/<slug>/SCHEDULE.md` → `schedule-<slug>`
 *
 * Issue #2526: Subdirectory layout mirrors the skills/ convention.
 */
function generateTaskId(filePath) {
    const dirName = path.basename(path.dirname(filePath));
    return `schedule-${dirName}`;
}
/**
 * ScheduleFileScanner - Scans and parses schedule markdown files.
 */
export class ScheduleFileScanner {
    schedulesDir;
    onDiagnostic;
    diagnosticFingerprints = new Map();
    constructor(options) {
        this.schedulesDir = options.schedulesDir;
        this.onDiagnostic = options.onDiagnostic;
        logger.info({ schedulesDir: this.schedulesDir }, 'ScheduleFileScanner initialized');
    }
    dispatchDiagnostic(diagnostic) {
        if (!this.onDiagnostic) {
            return;
        }
        try {
            const result = this.onDiagnostic(diagnostic);
            if (result && typeof result.then === 'function') {
                void result.catch(() => {
                    logger.warn({ filePath: diagnostic.filePath, taskId: diagnostic.taskId, code: diagnostic.code }, 'Schedule diagnostic notification failed');
                });
            }
        }
        catch {
            logger.warn({ filePath: diagnostic.filePath, taskId: diagnostic.taskId, code: diagnostic.code }, 'Schedule diagnostic notification failed');
        }
    }
    reportDiagnostic(options) {
        const fingerprint = JSON.stringify([options.severity, options.code, options.message, options.chatId ?? '']);
        if (this.diagnosticFingerprints.get(options.filePath) === fingerprint) {
            return;
        }
        this.diagnosticFingerprints.set(options.filePath, fingerprint);
        const { filePath, taskId, chatId, code, severity, message, line, column, unknownKeys } = options;
        const context = {
            filePath,
            taskId,
            code,
            ...(line !== undefined && { line }),
            ...(column !== undefined && { column }),
            ...(unknownKeys && { unknownKeys }),
        };
        if (severity === 'error') {
            logger.error(context, message);
        }
        else {
            logger.warn(context, message);
        }
        this.dispatchDiagnostic({ action: 'report', filePath, taskId, chatId, code, severity, message });
    }
    clearDiagnostic(filePath, chatId) {
        if (!this.diagnosticFingerprints.delete(filePath)) {
            return;
        }
        const taskId = generateTaskId(filePath);
        this.dispatchDiagnostic({ action: 'clear', filePath, taskId, chatId });
    }
    clearDiagnosticForFile(filePath) {
        this.clearDiagnostic(filePath);
    }
    /**
     * Ensure the schedules directory exists.
     */
    async ensureDir() {
        await fsPromises.mkdir(this.schedulesDir, { recursive: true });
    }
    /**
     * Scan all schedules and return parsed tasks.
     *
     * Issue #2526: Discovers `SCHEDULE.md` files inside subdirectories
     * (`schedules/<slug>/SCHEDULE.md`), mirroring the skills/ convention.
     */
    async scanAll() {
        await this.ensureDir();
        const tasks = [];
        const seenScheduleFiles = new Set();
        try {
            const entries = await fsPromises.readdir(this.schedulesDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) {
                    continue;
                }
                const scheduleFile = path.join(this.schedulesDir, entry.name, 'SCHEDULE.md');
                // Skip subdirectories that don't contain a SCHEDULE.md
                // to avoid misleading error-level logs from parseFile()
                try {
                    await fsPromises.access(scheduleFile);
                }
                catch {
                    continue;
                }
                seenScheduleFiles.add(scheduleFile);
                const task = await this.parseFile(scheduleFile);
                if (task) {
                    tasks.push(task);
                }
            }
            for (const filePath of this.diagnosticFingerprints.keys()) {
                if (!seenScheduleFiles.has(filePath)) {
                    this.clearDiagnostic(filePath);
                }
            }
            logger.info({ count: tasks.length }, 'Scanned schedule files');
            return tasks;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                logger.debug('Schedules directory does not exist, returning empty');
                return [];
            }
            throw error;
        }
    }
    /**
     * Parse a single schedule file.
     */
    async parseFile(filePath) {
        const taskId = generateTaskId(filePath);
        let chatId;
        let fileReadComplete = false;
        try {
            const content = await fsPromises.readFile(filePath, 'utf-8');
            fileReadComplete = true;
            const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
            if (match) {
                chatId = recoverChatId(match[1]);
            }
            const stats = await fsPromises.stat(filePath);
            const { frontmatter, contentStart, unknownKeys } = parseScheduleFrontmatter(content);
            const parsedChatId = frontmatter['chatId'];
            if (isSafeChatId(parsedChatId)) {
                chatId = parsedChatId;
            }
            const missingRequired = ['name', 'cron', 'chatId'].filter((key) => {
                const value = frontmatter[key];
                return typeof value !== 'string' || value.trim().length === 0;
            });
            if (missingRequired.length > 0) {
                throw new ScheduleFileParseError('missing-required-fields', `Required frontmatter fields are missing: ${missingRequired.join(', ')}.`);
            }
            const prompt = content.slice(contentStart).trim();
            const command = frontmatter['command'];
            if ((!prompt && !command) || (prompt && command)) {
                throw new ScheduleFileParseError('prompt-command-conflict', 'Define exactly one of a prompt body or the command field.');
            }
            for (const key of ['freshSession', 'skipHistory', 'clearContext']) {
                if (frontmatter[key] !== undefined && typeof frontmatter[key] !== 'boolean') {
                    throw new ScheduleFileParseError('invalid-context-options', `${key} must be true or false.`);
                }
            }
            const freshSession = frontmatter['freshSession']
                ?? (frontmatter['clearContext'] === false ? false : true);
            const skipHistory = frontmatter['skipHistory']
                ?? frontmatter['clearContext'] === true;
            if ((!freshSession && skipHistory) || (frontmatter['clearContext'] === true && (!freshSession || !skipHistory))) {
                throw new ScheduleFileParseError('invalid-context-options', 'skipHistory or clearContext:true requires freshSession:true and consistent context options.');
            }
            for (const key of ['cooldownPeriod', 'timeoutMs']) {
                const value = frontmatter[key];
                if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
                    throw new ScheduleFileParseError('invalid-number', `${key} must be a non-negative integer.`);
                }
            }
            if (frontmatter['timeoutMs'] === 0) {
                throw new ScheduleFileParseError('invalid-number', 'timeoutMs must be a positive integer.');
            }
            const task = {
                id: taskId,
                name: frontmatter['name'],
                cron: frontmatter['cron'],
                chatId: frontmatter['chatId'],
                prompt: prompt || undefined,
                command,
                enabled: frontmatter['enabled'] ?? true,
                blocking: frontmatter['blocking'] ?? true,
                clearContext: frontmatter['clearContext'],
                freshSession,
                skipHistory,
                cooldownPeriod: frontmatter['cooldownPeriod'],
                timeoutMs: frontmatter['timeoutMs'],
                createdBy: frontmatter['createdBy'],
                createdAt: frontmatter['createdAt'] || stats.birthtime.toISOString(),
                lastExecutedAt: frontmatter['lastExecutedAt'],
                timezone: frontmatter['timezone'],
                model: frontmatter['model'],
                sourceFile: filePath,
                fileMtime: stats.mtime,
            };
            // Issue #1338: Warn if model is specified but looks suspicious (e.g., empty)
            if (task.model && task.model.trim().length === 0) {
                logger.warn({ taskId: task.id, name: task.name }, 'Schedule task has empty model value, will be ignored');
            }
            else if (task.model) {
                logger.info({ taskId: task.id, name: task.name, model: task.model }, 'Schedule task will use model override');
            }
            // Issue #3860: Validate timezone against IANA database
            if (task.timezone) {
                const validTimezones = Intl.supportedValuesOf('timeZone');
                // Intl's list omits UTC even though Intl and the cron runtime accept it.
                if (task.timezone !== 'UTC' && !validTimezones.includes(task.timezone)) {
                    throw new ScheduleFileParseError('invalid-timezone', 'timezone must be a valid IANA timezone, such as America/New_York or UTC.');
                }
            }
            if (unknownKeys.length > 0) {
                this.reportDiagnostic({
                    filePath,
                    taskId,
                    chatId,
                    code: 'unknown-frontmatter-fields',
                    severity: 'warning',
                    message: `Unknown frontmatter fields are ignored: ${unknownKeys.join(', ')}. Check for spelling errors.`,
                    unknownKeys,
                });
            }
            else {
                this.clearDiagnostic(filePath, chatId);
            }
            logger.debug({ taskId, name: task.name }, 'Parsed schedule file');
            return task;
        }
        catch (error) {
            const location = yamlErrorLocation(error);
            const systemErrorCode = error?.code;
            const code = error instanceof ScheduleFileParseError
                ? error.code
                : !fileReadComplete || systemErrorCode ? 'schedule-file-read-failed' : 'invalid-schedule-frontmatter';
            const message = error instanceof ScheduleFileParseError
                ? error.message
                : !fileReadComplete || systemErrorCode
                    ? 'Schedule file could not be read; check the file path and permissions.'
                    : location.line !== undefined
                        ? `Invalid YAML frontmatter near line ${location.line}; check syntax, indentation, and quoting.`
                        : 'Invalid schedule configuration; check the required fields, supported keys, and value types.';
            this.reportDiagnostic({
                filePath,
                taskId,
                chatId,
                code,
                severity: 'error',
                message,
                ...location,
            });
            return null;
        }
    }
    /**
     * Write a task to a markdown file.
     *
     * Issue #2526: Writes to `schedules/<slug>/SCHEDULE.md` subdirectory layout.
     */
    async writeTask(task) {
        await this.ensureDir();
        const slug = task.id.startsWith('schedule-')
            ? task.id.slice('schedule-'.length)
            : task.id;
        const dirPath = path.join(this.schedulesDir, slug);
        await fsPromises.mkdir(dirPath, { recursive: true });
        const filePath = path.join(dirPath, 'SCHEDULE.md');
        const frontmatter = [
            '---',
            `name: "${task.name}"`,
            `cron: "${task.cron}"`,
            `enabled: ${task.enabled}`,
            `blocking: ${task.blocking ?? true}`,
            `chatId: ${task.chatId}`,
        ];
        if (task.cooldownPeriod) {
            frontmatter.push(`cooldownPeriod: ${task.cooldownPeriod}`);
        }
        if (task.timeoutMs) {
            frontmatter.push(`timeoutMs: ${task.timeoutMs}`);
        }
        if (task.createdBy) {
            frontmatter.push(`createdBy: ${task.createdBy}`);
        }
        if (task.createdAt) {
            frontmatter.push(`createdAt: "${task.createdAt}"`);
        }
        if (task.timezone) {
            frontmatter.push(`timezone: "${task.timezone}"`);
        }
        if (task.model) {
            frontmatter.push(`model: "${task.model}"`);
        }
        if (task.command) {
            frontmatter.push(`command: "${task.command.replaceAll('"', '\\"')}"`);
        }
        frontmatter.push('---', '');
        const content = frontmatter.join('\n') + (task.prompt ?? '');
        await fsPromises.writeFile(filePath, content, 'utf-8');
        logger.info({ taskId: task.id, filePath }, 'Wrote schedule file');
        return filePath;
    }
    /**
     * Delete a task file by task ID.
     *
     * Issue #2526: Deletes `schedules/<slug>/SCHEDULE.md` and removes the
     * subdirectory if it becomes empty.
     */
    async deleteTask(taskId) {
        if (!taskId.startsWith('schedule-')) {
            return false;
        }
        const slug = taskId.slice('schedule-'.length);
        const dirPath = path.join(this.schedulesDir, slug);
        const filePath = path.join(dirPath, 'SCHEDULE.md');
        try {
            await fsPromises.unlink(filePath);
            // Clean up empty subdirectory
            try {
                await fsPromises.rmdir(dirPath);
            }
            catch {
                // Directory not empty or other error — ignore
            }
            logger.info({ taskId, filePath }, 'Deleted schedule file');
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }
    /**
     * Get the file path for a task ID.
     *
     * Issue #2526: Returns `schedules/<slug>/SCHEDULE.md`.
     */
    getFilePath(taskId) {
        const slug = taskId.startsWith('schedule-')
            ? taskId.slice('schedule-'.length)
            : taskId;
        return path.join(this.schedulesDir, slug, 'SCHEDULE.md');
    }
}
/**
 * ScheduleFileWatcher - Watches schedule directory for changes.
 */
export class ScheduleFileWatcher {
    schedulesDir;
    onFileAdded;
    onFileChanged;
    onFileRemoved;
    debounceMs;
    rescanIntervalMs;
    renameCreateDelayMs;
    renameRemoveDelayMs;
    watcher = null;
    debounceTimers = new Map();
    rescanTimer = null;
    running = false;
    /** Guard against concurrent rescan execution */
    rescanInProgress = false;
    fileScanner;
    /** Tracks known task IDs from last scan for diff-based re-scan */
    knownTaskIds = new Set();
    /** Tracks known task mtimes for content change detection during re-scan */
    knownTaskMtimes = new Map();
    constructor(options) {
        this.schedulesDir = options.schedulesDir;
        this.onFileAdded = options.onFileAdded;
        this.onFileChanged = options.onFileChanged;
        this.onFileRemoved = options.onFileRemoved;
        this.debounceMs = options.debounceMs ?? 100;
        this.rescanIntervalMs = options.rescanIntervalMs ?? 5 * 60 * 1000;
        this.renameCreateDelayMs = options.renameCreateDelayMs ?? 50;
        this.renameRemoveDelayMs = options.renameRemoveDelayMs ?? 200;
        this.fileScanner = new ScheduleFileScanner({ schedulesDir: this.schedulesDir, onDiagnostic: options.onDiagnostic });
        logger.info({ schedulesDir: this.schedulesDir }, 'ScheduleFileWatcher initialized');
    }
    /**
     * Start watching the schedules directory.
     */
    async start() {
        if (this.running) {
            logger.warn('File watcher already running');
            return;
        }
        await fsPromises.mkdir(this.schedulesDir, { recursive: true });
        try {
            this.watcher = fs.watch(this.schedulesDir, { persistent: true, recursive: true }, (eventType, filename) => {
                this.handleFileEvent(eventType, filename);
            });
            this.watcher.on('error', (error) => {
                logger.error({ err: error }, 'File watcher error');
                if (error.code === 'EMFILE' || error.code === 'ENFILE') {
                    this.watcher?.close();
                    this.watcher = null;
                    logger.warn({ code: error.code, schedulesDir: this.schedulesDir }, 'File watcher unavailable; continuing with periodic re-scan fallback');
                }
            });
            this.running = true;
            logger.info({ schedulesDir: this.schedulesDir }, 'File watcher started');
            // Issue #3860: Start periodic re-scan as safety net for missed fs.watch events
            this.startRescanTimer();
        }
        catch (error) {
            const errnoError = error;
            if (errnoError.code === 'EMFILE' || errnoError.code === 'ENFILE') {
                this.watcher = null;
                this.running = true;
                logger.warn({ err: error, schedulesDir: this.schedulesDir }, 'File watcher unavailable; continuing with periodic re-scan fallback');
                this.startRescanTimer();
                return;
            }
            logger.error({ err: error }, 'Failed to start file watcher');
            throw error;
        }
    }
    /**
     * Perform a full re-scan and reconcile differences with known tasks.
     * Used as fallback when fs.watch events may have been missed.
     *
     * Issue #3860 P2: Periodic re-scan safety net.
     */
    async fullRescan() {
        if (this.rescanInProgress) {
            logger.debug('Re-scan already in progress, skipping');
            return;
        }
        this.rescanInProgress = true;
        try {
            const tasks = await this.fileScanner.scanAll();
            const currentTaskIds = new Set(tasks.map(t => t.id));
            // Find removed tasks
            for (const knownId of this.knownTaskIds) {
                if (!currentTaskIds.has(knownId)) {
                    logger.info({ taskId: knownId }, 'Re-scan detected removed task');
                    const filePath = this.fileScanner.getFilePath(knownId);
                    this.fileScanner.clearDiagnosticForFile(filePath);
                    this.onFileRemoved(knownId, filePath);
                }
            }
            // Find added/changed tasks
            for (const task of tasks) {
                if (!this.knownTaskIds.has(task.id)) {
                    logger.info({ taskId: task.id }, 'Re-scan detected new task');
                    this.onFileAdded(task);
                }
                else {
                    // Check if existing task content has changed (mtime comparison)
                    const knownMtime = this.knownTaskMtimes.get(task.id);
                    if (!knownMtime || task.fileMtime.getTime() > knownMtime.getTime()) {
                        logger.info({ taskId: task.id }, 'Re-scan detected changed task (mtime updated)');
                        this.onFileChanged(task);
                    }
                }
            }
            this.knownTaskIds = currentTaskIds;
            this.knownTaskMtimes = new Map(tasks.map(t => [t.id, t.fileMtime]));
            logger.debug({ taskCount: tasks.length }, 'Full re-scan completed');
        }
        catch (error) {
            logger.error({ err: error }, 'Full re-scan failed');
        }
        finally {
            this.rescanInProgress = false;
        }
    }
    /**
     * Update known task IDs and their mtimes. Called by the scheduler integration to
     * keep the watcher in sync after initial load.
     */
    setKnownTaskIds(taskIds, taskMtimes) {
        this.knownTaskIds = new Set(taskIds);
        if (taskMtimes) {
            this.knownTaskMtimes = new Map(taskMtimes);
        }
    }
    /**
     * Start the periodic re-scan timer.
     */
    startRescanTimer() {
        if (this.rescanIntervalMs <= 0) {
            return;
        }
        this.rescanTimer = setInterval(() => {
            if (this.running) {
                logger.debug('Periodic re-scan triggered');
                this.fullRescan().catch(err => {
                    logger.error({ err }, 'Unhandled fullRescan rejection (periodic)');
                });
            }
        }, this.rescanIntervalMs);
        logger.info({ intervalMs: this.rescanIntervalMs }, 'Periodic re-scan timer started');
    }
    /**
     * Stop watching.
     */
    stop() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.rescanTimer) {
            clearInterval(this.rescanTimer);
            this.rescanTimer = null;
        }
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
        this.running = false;
        logger.info('File watcher stopped');
    }
    /**
     * Check if watcher is running.
     */
    isRunning() {
        return this.running;
    }
    /**
     * Handle file system event with debouncing.
     *
     * Issue #2526: Filters for `SCHEDULE.md` files inside subdirectories.
     */
    handleFileEvent(eventType, filename) {
        // Issue #3860 P0: When filename is null (possible under high load or certain platforms),
        // trigger a full re-scan instead of silently discarding the event
        if (filename === null) {
            logger.warn({ eventType }, 'fs.watch emitted null filename, triggering full re-scan');
            this.fullRescan().catch(err => {
                logger.error({ err }, 'Unhandled fullRescan rejection (null filename)');
            });
            return;
        }
        if (!filename.endsWith('SCHEDULE.md')) {
            return;
        }
        const filePath = path.join(this.schedulesDir, filename);
        logger.debug({ eventType, filename }, 'File event received');
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);
            void this.processFileEvent(eventType, filePath, filename);
        }, this.debounceMs);
        this.debounceTimers.set(filePath, timer);
    }
    /**
     * Process the file event after debouncing.
     */
    async processFileEvent(eventType, filePath, _filename) {
        const taskId = generateTaskId(filePath);
        try {
            if (eventType === 'rename') {
                // Issue #3860 P1: Editors (vim, VSCode) use rename → create pattern on save.
                // Wait briefly before processing removal to avoid false remove when
                // the file is immediately recreated by the editor.
                const exists = await this.fileExists(filePath);
                if (exists) {
                    // File was created or recreated (rename-and-replace pattern)
                    // Brief delay to let the editor finish writing
                    await new Promise(resolve => setTimeout(resolve, this.renameCreateDelayMs));
                    const task = await this.fileScanner.parseFile(filePath);
                    if (task) {
                        logger.info({ taskId, filePath }, 'Schedule file added');
                        // Issue #3929: Sync knownTaskIds to prevent fullRescan from re-processing
                        this.knownTaskIds.add(task.id);
                        this.knownTaskMtimes.set(task.id, task.fileMtime);
                        this.onFileAdded(task);
                    }
                }
                else {
                    // File was removed. Delay briefly to check if it's a rename-and-replace
                    // where the create event arrives shortly after the rename.
                    await new Promise(resolve => setTimeout(resolve, this.renameRemoveDelayMs));
                    const existsAfterDelay = await this.fileExists(filePath);
                    if (existsAfterDelay) {
                        // File was recreated — treat as update, not remove+add
                        const task = await this.fileScanner.parseFile(filePath);
                        if (task) {
                            logger.info({ taskId, filePath }, 'Schedule file replaced (rename-and-replace pattern)');
                            // Issue #3929: Sync knownTaskMtimes to prevent fullRescan from re-processing
                            this.knownTaskMtimes.set(task.id, task.fileMtime);
                            this.onFileChanged(task);
                        }
                    }
                    else {
                        logger.info({ taskId, filePath }, 'Schedule file removed');
                        this.fileScanner.clearDiagnosticForFile(filePath);
                        // Issue #3929: Sync knownTaskIds to prevent fullRescan from re-processing
                        this.knownTaskIds.delete(taskId);
                        this.knownTaskMtimes.delete(taskId);
                        this.onFileRemoved(taskId, filePath);
                    }
                }
            }
            else if (eventType === 'change') {
                const task = await this.fileScanner.parseFile(filePath);
                if (task) {
                    logger.info({ taskId, filePath }, 'Schedule file changed');
                    // Issue #3929: Sync knownTaskMtimes to prevent fullRescan from re-processing
                    this.knownTaskMtimes.set(task.id, task.fileMtime);
                    this.onFileChanged(task);
                }
                else {
                    logger.warn({ taskId, filePath }, 'Schedule file became unparseable on change event');
                }
            }
        }
        catch (error) {
            logger.error({ err: error, filePath, eventType }, 'Error processing file event');
        }
    }
    /**
     * Check if a file exists.
     */
    async fileExists(filePath) {
        try {
            await fsPromises.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
}

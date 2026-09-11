/** Workspace-scoped storage for monthly execution records. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
export const TASK_RECORDS_DIR = 'task-records';
export const LEGACY_TASK_RECORDS_DIR = path.join('.claude', TASK_RECORDS_DIR);
export const LEGACY_TASK_RECORDS_FILE = path.join('.claude', 'task-records.md');
/**
 * New records are written to the workspace-scoped directory. Legacy Claude
 * locations are read-only compatibility sources and are never overwritten.
 */
export class TaskRecordStore {
    workspaceDir;
    directory;
    legacyDirectory;
    legacyFile;
    constructor(workspaceDir, options = {}) {
        this.workspaceDir = workspaceDir;
        this.directory = options.directory ?? TASK_RECORDS_DIR;
        this.legacyDirectory = options.legacyDirectory ?? LEGACY_TASK_RECORDS_DIR;
        this.legacyFile = options.legacyFile ?? LEGACY_TASK_RECORDS_FILE;
    }
    getMonthlyPath(month) {
        return path.join(this.workspaceDir, this.directory, `${month}.md`);
    }
    async append(month, entry) {
        const filePath = this.getMonthlyPath(month);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        try {
            await fs.access(filePath);
        }
        catch {
            await fs.writeFile(filePath, '# Task Records\n', 'utf8');
        }
        const separator = entry.startsWith('\n') ? '' : '\n';
        await fs.appendFile(filePath, `${separator}${entry.trimEnd()}\n`, 'utf8');
        return filePath;
    }
    /** Read monthly files, falling back to legacy files without writing them. */
    async readRecent(months, maxLines = 50) {
        const sections = [];
        for (const month of months) {
            const current = this.getMonthlyPath(month);
            const legacy = path.join(this.workspaceDir, this.legacyDirectory, `${month}.md`);
            const content = await this.readFirstAvailable([current, legacy]);
            if (content) {
                sections.push(content);
            }
        }
        const archive = await this.readFile(path.join(this.workspaceDir, this.legacyFile));
        if (archive) {
            sections.push(archive.split('\n').slice(-maxLines).join('\n'));
        }
        return sections.join('\n');
    }
    async readFirstAvailable(paths) {
        for (const filePath of paths) {
            const content = await this.readFile(filePath);
            if (content) {
                return content;
            }
        }
        return '';
    }
    async readFile(filePath) {
        try {
            return await fs.readFile(filePath, 'utf8');
        }
        catch {
            return '';
        }
    }
}

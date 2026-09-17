/** Workspace-scoped storage for monthly execution records. */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TASK_RECORDS_DIR = 'task-records';
export const LEGACY_TASK_RECORDS_DIR = path.join('.claude', TASK_RECORDS_DIR);
export const LEGACY_TASK_RECORDS_FILE = path.join('.claude', 'task-records.md');
export const MAX_TASK_RECORD_BYTES = 64 * 1024;

export interface TaskRecordStoreOptions {
  directory?: string;
  legacyDirectory?: string;
  legacyFile?: string;
}

/**
 * New records are written to the workspace-scoped directory. Legacy Claude
 * locations are read-only compatibility sources and are never overwritten.
 */
export class TaskRecordStore {
  private readonly directory: string;
  private readonly legacyDirectory: string;
  private readonly legacyFile: string;

  constructor(
    private readonly workspaceDir: string,
    options: TaskRecordStoreOptions = {},
  ) {
    this.directory = options.directory ?? TASK_RECORDS_DIR;
    this.legacyDirectory = options.legacyDirectory ?? LEGACY_TASK_RECORDS_DIR;
    this.legacyFile = options.legacyFile ?? LEGACY_TASK_RECORDS_FILE;
  }

  getMonthlyPath(month: string): string {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error('Month must be YYYY-MM');
    }
    return path.join(this.workspaceDir, this.directory, `${month}.md`);
  }

  async append(month: string, entry: string): Promise<string> {
    const filePath = this.getMonthlyPath(month);
    const payload = Buffer.from(`\n${entry.trim()}\n`, 'utf8');
    if (!entry.trim() || payload.length > MAX_TASK_RECORD_BYTES) {
      throw new Error('Task record must be non-empty and at most 64 KiB including separators');
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // Publish a complete header without ever opening the monthly file for
    // truncation. access -> writeFile (even wx) leaves an initialization race
    // with another process appending before the header has been written.
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, '# Task Records\n', { flag: 'wx' });
      try {
        await fs.link(temporary, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
    const handle = await fs.open(filePath, 'a');
    try {
      // One bounded O_APPEND write: independent local processes cannot seek
      // back over earlier entries or interleave a series of chunked writes.
      const { bytesWritten } = await handle.write(payload);
      if (bytesWritten !== payload.length) {
        throw new Error('Partial task record append; inspect the file before retrying');
      }
    } finally {
      await handle.close();
    }
    return filePath;
  }

  /** Read monthly files, falling back to legacy files without writing them. */
  async readRecent(months: string[], maxLines = 50): Promise<string> {
    const sections: string[] = [];
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

  private async readFirstAvailable(paths: string[]): Promise<string> {
    for (const filePath of paths) {
      const content = await this.readFile(filePath);
      if (content) {
        return content;
      }
    }
    return '';
  }

  private async readFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch {
      return '';
    }
  }
}

import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FileRef } from '@disclaude/core';
import type { IFileStorageService } from './types.js';

interface RecordV1 { version: 1; ref: FileRef; sha256: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const digest = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

/** Persistent REST uploads. Each complete object is published by one directory rename. */
export class FileStorageService implements IFileStorageService {
  private readonly root: string;
  private readonly files = new Map<string, RecordV1>();
  private initialized = false;
  constructor(private readonly config: { storageDir: string; maxFileSize: number }) {
    if (!Number.isSafeInteger(config.maxFileSize) || config.maxFileSize < 1) { throw new Error('File size limit must be a positive integer'); }
    this.root = resolve(config.storageDir, 'objects-v1');
  }
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const loaded = new Map<string, RecordV1>();
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      // Interrupted unpublished uploads and pre-existing storage are retained.
      if (!entry.isDirectory() || !uuid.test(entry.name)) { continue; }
      const directory = join(this.root, entry.name);
      const metadata = join(directory, 'record.json');
      if ((await stat(metadata)).size > 16_384) { throw new Error('Stored file metadata is oversized'); }
      const record = JSON.parse(await readFile(metadata, 'utf8')) as RecordV1;
      const ref = record?.ref;
      const content = await stat(join(directory, 'content'));
      if (record?.version !== 1 || ref?.id !== entry.name || typeof ref.fileName !== 'string'
        || !['user', 'agent'].includes(ref.source) || !Number.isFinite(ref.createdAt)
        || !content.isFile() || content.size !== ref.size || !/^[a-f0-9]{64}$/u.test(record.sha256)) {
        throw new Error(`Stored file metadata is invalid: ${entry.name}`);
      }
      ref.localPath = join(directory, 'content');
      loaded.set(ref.id, record);
    }
    this.files.clear();
    for (const [id, record] of loaded) { this.files.set(id, record); }
    this.initialized = true;
  }
  shutdown(): void { this.initialized = false; this.files.clear(); }
  async storeFromBase64(base64: string, fileName: string, mimeType?: string, source: 'user' | 'agent' = 'user'): Promise<FileRef> {
    if (!this.initialized) { throw new Error('File storage is not initialized'); }
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255 || /[/\\\0]/u.test(fileName)) {
      throw new Error('Invalid file name');
    }
    if (mimeType !== undefined && (typeof mimeType !== 'string' || mimeType.length > 255)) { throw new Error('Invalid MIME type'); }
    const normalized = base64.replace(/\s/gu, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 === 1
      || normalized.length > Math.ceil(this.config.maxFileSize / 3) * 4) { throw new Error('Invalid or oversized file content'); }
    const content = Buffer.from(normalized, 'base64');
    if (content.length > this.config.maxFileSize || content.toString('base64').replace(/=+$/u, '') !== normalized.replace(/=+$/u, '')) {
      throw new Error('Invalid or oversized file content');
    }
    const id = randomUUID(), directory = join(this.root, id), pending = join(this.root, `.pending-${id}`);
    const ref: FileRef = { id, fileName, mimeType, source, size: content.length, createdAt: Date.now(), localPath: join(directory, 'content') };
    const record: RecordV1 = { version: 1, ref, sha256: digest(content) };
    await mkdir(pending, { mode: 0o700 });
    try {
      await writeFile(join(pending, 'content'), content, { flag: 'wx', mode: 0o600 });
      await writeFile(join(pending, 'record.json'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(pending, directory);
      this.files.set(id, record);
      return { ...ref };
    } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
  }
  get(id: string): { ref: FileRef } | undefined {
    const record = this.files.get(id);
    return record ? { ref: { ...record.ref } } : undefined;
  }
  async getContent(id: string): Promise<string> {
    const record = this.files.get(id);
    if (!record || !uuid.test(id)) { throw new Error('File not found'); }
    const content = await readFile(join(this.root, id, 'content'));
    if (content.length !== record.ref.size || digest(content) !== record.sha256) { throw new Error('Stored file content failed integrity verification'); }
    return content.toString('base64');
  }
}

export const persistentFileStorageProvider = (): Promise<{ FileStorageService: typeof FileStorageService }> => Promise.resolve({ FileStorageService });

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStorageService } from './file-storage.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
async function fixture(maxFileSize = 1024) {
  const root = await mkdtemp(join(tmpdir(), 'rest-files-')); roots.push(root);
  const directory = join(root, 'files');
  const store = new FileStorageService({ storageDir: directory, maxFileSize });
  await store.initialize();
  return { root, directory, store };
}
describe('persistent REST file storage', () => {
  it('retains concurrent uploads across reopening and relocation without trusting stored absolute paths', async () => {
    const { root, directory, store } = await fixture();
    const values = ['first upload', 'second upload'];
    const refs = await Promise.all(values.map((v, i) => store.storeFromBase64(Buffer.from(v).toString('base64'), `file-${i}.txt`, 'text/plain')));
    store.shutdown();
    const moved = join(root, 'moved'); await rename(directory, moved);
    const reopened = new FileStorageService({ storageDir: moved, maxFileSize: 1024 });
    await reopened.initialize();
    for (const [i, ref] of refs.entries()) {
      expect(reopened.get(ref.id)?.ref.fileName).toBe(ref.fileName);
      expect(reopened.get(ref.id)?.ref.localPath).toContain(moved);
      expect(Buffer.from(await reopened.getContent(ref.id), 'base64').toString()).toBe(values[i]);
      const copy = reopened.get(ref.id)!; copy.ref.size = 0;
      expect(reopened.get(ref.id)?.ref.size).toBe(ref.size);
    }
    reopened.shutdown();
  });
  it('rejects escaping names, invalid encoding and oversized uploads without modifying outside files', async () => {
    const { root, store } = await fixture(4);
    await writeFile(join(root, 'outside'), 'keep');
    await expect(store.storeFromBase64('YQ==', '../outside')).rejects.toThrow('file name');
    await expect(store.storeFromBase64('a', 'bad')).rejects.toThrow('content');
    await expect(store.storeFromBase64(Buffer.from('too long').toString('base64'), 'large')).rejects.toThrow('oversized');
    await expect(store.getContent('../../outside')).rejects.toThrow('not found');
    expect(await readFile(join(root, 'outside'), 'utf8')).toBe('keep');
    store.shutdown();
  });
  it('preserves incomplete staging data and fails visibly for corrupt published content', async () => {
    const { directory, store } = await fixture();
    const staged = join(directory, 'objects-v1', '.pending-interrupted');
    await mkdir(staged); await writeFile(join(staged, 'content'), 'unfinished');
    const ref = await store.storeFromBase64('ZGF0YQ==', 'report.txt');
    store.shutdown();
    await writeFile(ref.localPath!, 'oops');
    const reopened = new FileStorageService({ storageDir: directory, maxFileSize: 1024 });
    await reopened.initialize();
    await expect(reopened.getContent(ref.id)).rejects.toThrow('integrity');
    expect(await readFile(join(staged, 'content'), 'utf8')).toBe('unfinished');
    reopened.shutdown();
  });
});

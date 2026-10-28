import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readProjectArtifact } from './project-artifact.js';

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'project-artifact-')); roots.push(root);
  await fs.mkdir(join(root, 'reports')); return root;
}

it.each([Buffer.alloc(0), Buffer.from('exact artifact\n'), Buffer.alloc(256 * 1024, 7)])(
  'hashes actual file bytes with a relative reference and leaves its contents unchanged (%#)', async body => {
    const root = await fixture(), file = join(root, 'reports', 'output.bin'); await fs.writeFile(file, body);
    const before = await fs.stat(file);
    expect(await readProjectArtifact(root, 'reports/output.bin')).toEqual({ ref: 'reports/output.bin', bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex') });
    expect(await fs.readFile(file)).toEqual(body); expect((await fs.stat(file)).mtimeMs).toBe(before.mtimeMs);
  });

it.each(['', '/tmp/external', '../external', 'reports/../output', 'reports//output', './output', 'reports\\output', 'bad\0ref'])(
  'rejects non-canonical references before accessing files (%s)', async ref => {
    await expect(readProjectArtifact(await fixture(), ref)).rejects.toThrow('relative Project');
  });

it('rejects missing, directory and redirected artifacts, including redirects inside the Project', async () => {
  const root = await fixture(), other = await fixture();
  await fs.writeFile(join(other, 'outside'), 'external-canary'); await fs.writeFile(join(root, 'inside'), 'inside');
  await fs.symlink(join(other, 'outside'), join(root, 'outside-link'));
  await fs.symlink(join(root, 'inside'), join(root, 'inside-link'));
  await fs.symlink(join(other, 'reports'), join(root, 'redirected-directory'));
  for (const ref of ['missing', 'reports', 'outside-link', 'inside-link', 'redirected-directory/output']) {
    await expect(readProjectArtifact(root, ref)).rejects.toThrow('Cannot verify');
  }
  expect(await fs.readFile(join(other, 'outside'), 'utf8')).toBe('external-canary');
});

it('refuses a file modified while its bytes are being streamed', async () => {
  const root = await fixture(), file = join(root, 'artifact'); await fs.writeFile(file, 'original');
  const { open } = fs;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    vi.spyOn(handle, 'createReadStream').mockReturnValue(Readable.from((async function* () {
      yield Buffer.from('original'); await fs.writeFile(file, 'changed-during-read');
    })()) as ReturnType<typeof handle.createReadStream>);
    return handle;
  });
  await expect(readProjectArtifact(root, 'artifact')).rejects.toThrow('stable');
  expect(await fs.readFile(file, 'utf8')).toBe('changed-during-read');
});

it('refuses a path replaced after its file handle was opened', async () => {
  const root = await fixture(), file = join(root, 'artifact'); await fs.writeFile(file, 'original');
  const { open } = fs;
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await open(...args);
    await fs.rename(file, join(root, 'previous')); await fs.writeFile(file, 'replacement'); return handle;
  });
  await expect(readProjectArtifact(root, 'artifact')).rejects.toThrow('stable');
  expect(await fs.readFile(file, 'utf8')).toBe('replacement'); expect(await fs.readFile(join(root, 'previous'), 'utf8')).toBe('original');
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectChromiumZip, installChromiumCandidate, chromiumDownloadLayout } from '../scripts/chromium-download.mjs';

function zip(entries: Array<{ name: string; target?: string }>) {
  const files: Buffer[] = [], records: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), data = Buffer.from(entry.target || 'test');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.target ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    files.push(local, name, data); records.push(central, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(records), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
async function withZip(entries: Array<{ name: string; target?: string }>, check: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'dc-zip-boundary-'));
  try { const path = join(root, 'browser.zip'); await writeFile(path, zip(entries)); await check(path); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe('download candidate boundaries', () => {
  it('rejects an unsupported architecture instead of choosing an x64 build', () => {
    expect(() => chromiumDownloadLayout('linux', 'arm64')).toThrow('select an existing browser');
    expect(chromiumDownloadLayout('darwin', 'arm64').platform).toBe('Mac_Arm');
  });
  it('accepts the internal framework symlinks used by app bundles', () => withZip([
    { name: 'bundle/Versions/A/file' }, { name: 'bundle/Versions/Current', target: 'A' }, { name: 'bundle/file', target: 'Versions/Current/file' },
  ], async path => { expect((await inspectChromiumZip(path)).entries).toBe(3); }));
  it.each(['../outside', '/absolute', 'C:/absolute', 'dir\\outside'])('rejects unsafe archive member %s', name => withZip([{ name }], async path => {
    await expect(inspectChromiumZip(path)).rejects.toThrow('Unsafe browser ZIP path');
  }));
  it('rejects symlink traversal that only escapes after following another symlink', () => withZip([
    { name: 'a', target: 'dir/b/../..' }, { name: 'dir/b', target: '../c' }, { name: 'c/file' },
  ], async path => { await expect(inspectChromiumZip(path)).rejects.toThrow('escapes extraction root'); }));
  it('rejects symlink cycles and case-folded duplicate paths', async () => {
    await withZip([{ name: 'a', target: 'b' }, { name: 'b', target: 'a' }], async path => { await expect(inspectChromiumZip(path)).rejects.toThrow('cycle'); });
    await withZip([{ name: 'File' }, { name: 'file' }], async path => { await expect(inspectChromiumZip(path, true)).rejects.toThrow('Duplicate'); });
  });
  it('removes a corrupt download and its lock while preserving existing caller data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dc-download-corrupt-'));
    await writeFile(join(root, 'keep'), 'caller data');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('corrupt'), { headers: { 'x-goog-generation': '123' } })));
    try {
      await expect(installChromiumCandidate({ destination: join(root, 'candidate'), size: 7, url: 'https://example.test/archive', generation: '123', md5: 'wrong' })).rejects.toThrow('integrity check failed');
      expect(await readFile(join(root, 'keep'), 'utf8')).toBe('caller data');
      expect(await readdir(root)).toEqual(['keep']);
    } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
  });
});

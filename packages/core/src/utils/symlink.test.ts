/**
 * Tests for ensureSymlinkSync (Issue #4224 part 1 + part 2 sync).
 *
 * Verifies symlink creation, idempotency, replacement, migration of a stale
 * copy-on-start entry, and the skip-on-unexpected-type guard. Uses real temp
 * directories.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ensureSymlinkSync } from './symlink.js';

describe('ensureSymlinkSync', () => {
  let tempDir: string;
  let sourceDir: string;
  let linkDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'symlink-test-'));
    sourceDir = path.join(tempDir, 'source');
    linkDir = path.join(tempDir, 'links');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(linkDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates a directory symlink pointing to the source (content readable through it)', async () => {
    const src = path.join(sourceDir, 'skill-a');
    await fs.mkdir(path.join(src), { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '# A');

    const link = path.join(linkDir, 'skill-a');
    ensureSymlinkSync(src, link, 'dir');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(link, 'SKILL.md'), 'utf-8')).toBe('# A');
  });

  it('creates a file symlink', async () => {
    const src = path.join(sourceDir, 'agent.md');
    await fs.writeFile(src, '# Agent');
    const link = path.join(linkDir, 'agent.md');

    ensureSymlinkSync(src, link, 'file');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(link, 'utf-8')).toBe('# Agent');
  });

  it('is idempotent: re-running with the same source is a no-op', async () => {
    const src = path.join(sourceDir, 'skill');
    await fs.mkdir(src, { recursive: true });
    const link = path.join(linkDir, 'skill');

    ensureSymlinkSync(src, link, 'dir');
    ensureSymlinkSync(src, link, 'dir'); // no throw

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('reflects source changes through the symlink (no stale copy)', async () => {
    const src = path.join(sourceDir, 'skill');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), 'v1');
    const link = path.join(linkDir, 'skill');

    ensureSymlinkSync(src, link, 'dir');
    await fs.writeFile(path.join(src, 'SKILL.md'), 'v2');

    expect(await fs.readFile(path.join(link, 'SKILL.md'), 'utf-8')).toBe('v2');
  });

  it('replaces a symlink that points to a different source', async () => {
    const src1 = path.join(sourceDir, 'a1');
    const src2 = path.join(sourceDir, 'a2');
    await fs.mkdir(src1, { recursive: true });
    await fs.mkdir(src2, { recursive: true });
    await fs.writeFile(path.join(src1, 'SKILL.md'), 'one');
    await fs.writeFile(path.join(src2, 'SKILL.md'), 'two');
    const link = path.join(linkDir, 'skill');

    ensureSymlinkSync(src1, link, 'dir');
    ensureSymlinkSync(src2, link, 'dir');

    expect(await fs.readFile(path.join(link, 'SKILL.md'), 'utf-8')).toBe('two');
  });

  it('migrates an existing real directory (old copy-on-start) into a symlink', async () => {
    const src = path.join(sourceDir, 'skill');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(path.join(src, 'SKILL.md'), '# Real');
    const link = path.join(linkDir, 'skill');

    // Pre-existing stale materialized copy (the old behavior's artifact),
    // including a user-added file that the old copy left behind.
    await fs.mkdir(link, { recursive: true });
    await fs.writeFile(path.join(link, 'SKILL.md'), '# Stale');
    await fs.writeFile(path.join(link, 'user-custom.md'), 'custom');

    ensureSymlinkSync(src, link, 'dir');

    // The skill is now a symlink reflecting the source — stale copy + its
    // extra file are gone (this is the intended #4224 cutover).
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(path.join(link, 'SKILL.md'), 'utf-8')).toBe('# Real');
    await expect(fs.access(path.join(link, 'user-custom.md'))).rejects.toThrow();
  });

  it('migrates an existing real file (old copyFile) into a file symlink', async () => {
    const src = path.join(sourceDir, 'agent.md');
    await fs.writeFile(src, '# Real');
    const link = path.join(linkDir, 'agent.md');

    await fs.writeFile(link, '# Stale'); // old copyFile artifact

    ensureSymlinkSync(src, link, 'file');

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(link, 'utf-8')).toBe('# Real');
  });
});

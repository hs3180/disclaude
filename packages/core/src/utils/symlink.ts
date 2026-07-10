/**
 * Symlink helper for in-place discovery of builtin skills/agents (Issue #4224).
 *
 * Replaces the old "copy-on-start" materialization (`copyDirectory` / `copyFile`
 * in `skills-setup.ts` / `agents-setup.ts`) with symlinks into the package
 * install dir. A symlink is always current (no stale copy after upgrade),
 * costs nothing to keep fresh (no per-restart overwrite IO), and doesn't
 * clobber anything — the link simply points at the read-only package resource.
 *
 * `ensureSymlinkSync` is **synchronous** (Issue #4224 part 2): it is invoked
 * from `getProvider()` (called in the `BaseAgent` constructor, which is sync),
 * so completing the link synchronously inside `getProvider` eliminates the
 * first-message race — the symlink exists before the provider is returned.
 *
 * It is idempotent and migrates an existing stale copy (a real dir/file left by
 * the previous copy-on-start) into a symlink.
 */
import { symlinkSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import * as path from 'path';
import { createLogger } from './logger.js';

const logger = createLogger('SymlinkSetup');

export type SymlinkType = 'dir' | 'file';

/**
 * Ensure `linkPath` is a symlink pointing to `realSource` — **synchronous**.
 *
 * - If `linkPath` does not exist: create the symlink.
 * - If it is already a symlink to `realSource`: no-op (idempotent).
 * - If it is a symlink to somewhere else: replace it.
 * - If it is a real dir/file (a stale copy-on-start materialization): remove
 *   it and create the symlink (the one-time migration to #4224's model). These
 *   entries were auto-managed by the old setup, so removing them is safe.
 * - Any other type (socket/device/...): leave untouched and warn.
 *
 * @param realSource - Absolute (or resolvable) path the link should point to.
 * @param linkPath - Absolute (or resolvable) path where the link should live.
 * @param type - `'dir'` for a directory symlink, `'file'` for a file symlink.
 */
export function ensureSymlinkSync(realSource: string, linkPath: string, type: SymlinkType): void {
  const source = path.resolve(realSource);
  const link = path.resolve(linkPath);

  // Fast path: create the symlink.
  try {
    symlinkSync(source, link, type);
    return;
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code !== 'EEXIST') {
      throw err;
    }
  }

  // `link` already exists — reconcile to the desired symlink.
  let stat;
  try {
    stat = lstatSync(link);
  } catch {
    // Entry raced away between the failed symlink and the lstat — retry once.
    symlinkSync(source, link, type);
    return;
  }

  if (stat.isSymbolicLink()) {
    const currentTarget = path.resolve(path.dirname(link), readlinkSync(link));
    if (currentTarget === source) {
      return; // Already the right symlink — idempotent no-op.
    }
    rmSync(link, { force: true });
    symlinkSync(source, link, type);
    return;
  }

  if (stat.isDirectory() || stat.isFile()) {
    // Stale materialized copy from the old copy-on-start — migrate to a symlink.
    logger.info(
      { linkPath: link, source, wasDirectory: stat.isDirectory() },
      'Replacing stale copy-on-start entry with symlink (Issue #4224)',
    );
    rmSync(link, { recursive: stat.isDirectory(), force: true });
    symlinkSync(source, link, type);
    return;
  }

  // Unexpected entry type (socket, device, FIFO, ...) — don't clobber it.
  logger.warn({ linkPath: link }, 'ensureSymlinkSync: unexpected existing entry type, leaving untouched');
}

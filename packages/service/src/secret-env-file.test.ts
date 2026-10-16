import { chmodSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadSecretEnvFile } from './secret-env-file.js';

it('loads an explicit owner-only file without shell evaluation, preserving inherited precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-env-'));
  const file = join(dir, 'secrets.env');
  try {
    writeFileSync(file, '# external secrets\nKEY=file-value\nEMPTY=file-value\nLITERAL="$(not-executed) ${NOT_EXPANDED}"\n', { mode: 0o600 });
    const env = { KEY: 'inherited-value', EMPTY: '' } as NodeJS.ProcessEnv;
    loadSecretEnvFile(file, env);
    expect(env).toEqual({ KEY: 'inherited-value', EMPTY: '', LITERAL: '$(not-executed) ${NOT_EXPANDED}' });
    chmodSync(file, 0o644);
    expect(() => loadSecretEnvFile(file, {})).toThrow('owner-only');
  } finally {rmSync(dir, { recursive: true, force: true });}
});

it('does not partially apply a malformed file or reflect its contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-env-'));
  const file = join(dir, 'secrets.env');
  try {
    writeFileSync(file, 'KEY=synthetic-private-canary\nsynthetic-private-canary\n', { mode: 0o600 });
    const env = {};
    expect(() => loadSecretEnvFile(file, env)).toThrow('line 2');
    expect(env).toEqual({});
    try {loadSecretEnvFile(file, env);} catch (error) {expect(String(error)).not.toContain('synthetic-private-canary');}
  } finally {rmSync(dir, { recursive: true, force: true });}
});

it('rejects symlinks, directories, oversize files and FIFOs without blocking or applying variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-env-shape-'));
  try {
    const file = join(dir, 'secret'); writeFileSync(file, 'KEY=owned-value', { mode: 0o600 });
    const link = join(dir, 'link'); symlinkSync(file, link);
    const directory = join(dir, 'directory'); mkdirSync(directory, { mode: 0o700 });
    const large = join(dir, 'large'); writeFileSync(large, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    for (const path of [link, directory, large]) { expect(() => loadSecretEnvFile(path, {})).toThrow(); }
    if (process.platform !== 'win32') {
      const fifo = join(dir, 'fifo'); execFileSync('mkfifo', ['-m', '600', fifo]);
      expect(() => loadSecretEnvFile(fifo, {})).toThrow('regular owner-only');
    }
  } finally {rmSync(dir, { recursive: true, force: true });}
});

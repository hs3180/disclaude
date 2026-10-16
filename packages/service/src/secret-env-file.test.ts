import { chmodSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadSecretEnvFile } from './secret-env-file.js';
import { externalSecretEnvironmentNames } from '@disclaude/core/secret-environment';

afterEach(() => vi.unstubAllEnvs());

it('records every host-file variable name after parsing, including inherited and empty overrides', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-provenance-'));
  const file = join(dir, 'secrets.env');
  vi.stubEnv('OPAQUE_PROVENANCE_UNUSED', undefined);
  vi.stubEnv('OPAQUE_PROVENANCE_INHERITED', 'synthetic-inherited-value');
  vi.stubEnv('OPAQUE_PROVENANCE_EMPTY', '');
  try {
    writeFileSync(file, 'OPAQUE_PROVENANCE_UNUSED=synthetic-file-value\nOPAQUE_PROVENANCE_INHERITED=synthetic-file-value\nOPAQUE_PROVENANCE_EMPTY=synthetic-file-value\n', { mode: 0o600 });
    loadSecretEnvFile(file);
    expect(process.env.OPAQUE_PROVENANCE_UNUSED).toBe('synthetic-file-value');
    expect(process.env.OPAQUE_PROVENANCE_INHERITED).toBe('synthetic-inherited-value');
    expect(process.env.OPAQUE_PROVENANCE_EMPTY).toBe('');
    expect(externalSecretEnvironmentNames()).toEqual(expect.arrayContaining([
      'OPAQUE_PROVENANCE_UNUSED', 'OPAQUE_PROVENANCE_INHERITED', 'OPAQUE_PROVENANCE_EMPTY',
    ]));
    expect(JSON.stringify(externalSecretEnvironmentNames())).not.toContain('synthetic-');
  } finally {rmSync(dir, { recursive: true, force: true });}
});

it('imports the pure registry subpath without initializing Config before the preloader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-preload-'));
  try {
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"agents":{"default":{"backend":"codex","llm":"native"}},"llms":{"native":{"model":"gpt-6-luna"}}}');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      'await import("@disclaude/core/secret-environment"); process.stdout.write("PURE_REGISTRY_IMPORTED");'], {
      cwd: resolve('.'), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: 'production',
        DISCLAUDE_CONFIG_PATH: file },
    });
    expect(output).toBe('PURE_REGISTRY_IMPORTED');
  } finally {rmSync(dir, { recursive: true, force: true });}
});

it('does not register or apply names from a malformed host file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'disclaude-secret-atomic-provenance-'));
  const file = join(dir, 'secrets.env');
  vi.stubEnv('OPAQUE_REJECTED_FILE', undefined);
  try {
    writeFileSync(file, 'OPAQUE_REJECTED_FILE=synthetic-file-value\ninvalid line\n', { mode: 0o600 });
    expect(() => loadSecretEnvFile(file)).toThrow('line 2');
    expect(process.env.OPAQUE_REJECTED_FILE).toBeUndefined();
    expect(externalSecretEnvironmentNames()).not.toContain('OPAQUE_REJECTED_FILE');
  } finally {rmSync(dir, { recursive: true, force: true });}
});

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

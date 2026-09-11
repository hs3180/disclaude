import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadRuntimeEnv, setRuntimeEnv, deleteRuntimeEnv } from './runtime-env.js';

describe('runtime-env', () => {
  let tmpDir: string;
  let expiry: string;
  const writeToken = (value: string) => setRuntimeEnv(tmpDir, 'GH_TOKEN', value, { expiresAt: expiry });

  beforeEach(() => {
    expiry = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates private files and tightens permissions on legacy files', () => {
    writeToken('value');
    const target = path.join(tmpDir, '.runtime-env');
    if (process.platform === 'win32') {return;}
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    fs.chmodSync(target, 0o644);
    expect(loadRuntimeEnv(tmpDir)).toMatchObject({ GH_TOKEN: 'value' });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it.each(['symlink', 'hardlink', 'directory'])('refuses an unsafe %s without changing its target', kind => {
    const source = path.join(tmpDir, 'source');
    const target = path.join(tmpDir, '.runtime-env');
    fs.writeFileSync(source, 'KEY=original\n');
    if (kind === 'symlink') {fs.symlinkSync(source, target);}
    else if (kind === 'hardlink') {fs.linkSync(source, target);}
    else {fs.mkdirSync(target);}
    expect(loadRuntimeEnv(tmpDir)).toEqual({});
    expect(() => writeToken('replacement')).toThrow('safely');
    expect(() => deleteRuntimeEnv(tmpDir, 'GH_TOKEN')).toThrow('safely');
    expect(fs.readFileSync(source, 'utf8')).toBe('KEY=original\n');
  });

  it('preserves previous credentials and removes temporary files on a failed replacement', () => {
    writeToken('original');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {throw new Error('disk failure');});
    expect(() => writeToken('replacement')).toThrow('safely');
    expect(loadRuntimeEnv(tmpDir)).toMatchObject({ GH_TOKEN: 'original' });
    expect(fs.readdirSync(tmpDir)).toEqual(['.runtime-env']);
  });

  it('injects only registered, unexpired derived credentials', () => {
    fs.writeFileSync(path.join(tmpDir, '.runtime-env'),
      `# derived token\nGH_TOKEN="ghs_abc"\nGH_TOKEN_EXPIRES_AT=${expiry}\nGH_REPO=owner/repo\nPATH=/malicious\nNODE_OPTIONS=--require=evil\nUNREGISTERED=value\n__proto__=value\n`);
    expect(loadRuntimeEnv(tmpDir)).toEqual({ GH_TOKEN: 'ghs_abc', GH_TOKEN_EXPIRES_AT: expiry, GH_REPO: 'owner/repo' });
    expect(loadRuntimeEnv(tmpDir, Date.parse(expiry))).toEqual({});
  });

  it.each(['', 'invalid', '2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z'])('does not inject credentials with invalid expiry %s', value => {
    fs.writeFileSync(path.join(tmpDir, '.runtime-env'), `GH_TOKEN=ghs_abc\nGH_TOKEN_EXPIRES_AT=${value}\n`);
    expect(loadRuntimeEnv(tmpDir)).toEqual({});
    expect(() => setRuntimeEnv(tmpDir, 'GH_TOKEN', 'replacement', { expiresAt: value })).toThrow();
  });

  it.each(['PATH', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'AWS_KEY', 'GH_TOKEN\nPATH'])('rejects unregistered key %s', key => {
    expect(() => setRuntimeEnv(tmpDir, key, 'value')).toThrow('Invalid runtime');
    expect(fs.existsSync(path.join(tmpDir, '.runtime-env'))).toBe(false);
  });

  it.each(['token\nPATH=evil', 'token\rOTHER=evil', 'token\0evil'])('rejects value injection without including the value in errors', value => {
    expect(() => setRuntimeEnv(tmpDir, 'GH_TOKEN', value, { expiresAt: expiry })).toThrow('Invalid runtime environment entry');
  });

  it('requires expiry in the same token update and preserves other fields', () => {
    writeToken('old');
    setRuntimeEnv(tmpDir, 'GH_REPO', 'owner/repo');
    expect(() => setRuntimeEnv(tmpDir, 'GH_TOKEN', 'new')).toThrow('expiry');
    writeToken('new');
    expect(loadRuntimeEnv(tmpDir)).toMatchObject({ GH_TOKEN: 'new', GH_REPO: 'owner/repo' });
    deleteRuntimeEnv(tmpDir, 'GH_REPO');
    deleteRuntimeEnv(tmpDir, 'GH_TOKEN');
    expect(fs.existsSync(path.join(tmpDir, '.runtime-env'))).toBe(false);
  });

  it('removes expired credentials without depending on injection eligibility', () => {
    writeToken('old');
    expect(loadRuntimeEnv(tmpDir, Date.parse(expiry) + 1)).toEqual({});
    deleteRuntimeEnv(tmpDir, 'GH_TOKEN');
    expect(fs.existsSync(path.join(tmpDir, '.runtime-env'))).toBe(false);
  });
});

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { loadRuntimeEnv, setRuntimeEnv, deleteRuntimeEnv } from './runtime-env.js';

describe('runtime-env', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-env-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates private files and tightens permissions on legacy files', () => {
    setRuntimeEnv(tmpDir, 'KEY', 'value');
    const target = path.join(tmpDir, '.runtime-env');
    if (process.platform === 'win32') {return;}
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    fs.chmodSync(target, 0o644);
    expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'value' });
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
    expect(() => setRuntimeEnv(tmpDir, 'KEY', 'replacement')).toThrow('safely');
    expect(() => deleteRuntimeEnv(tmpDir, 'KEY')).toThrow('safely');
    expect(fs.readFileSync(source, 'utf8')).toBe('KEY=original\n');
  });

  it('preserves previous credentials and removes temporary files on a failed replacement', () => {
    setRuntimeEnv(tmpDir, 'KEY', 'original');
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {throw new Error('disk failure');});
    expect(() => setRuntimeEnv(tmpDir, 'KEY', 'replacement')).toThrow('safely');
    expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'original' });
    expect(fs.readdirSync(tmpDir)).toEqual(['.runtime-env']);
  });

  describe('loadRuntimeEnv', () => {
    it('returns empty object when file does not exist', () => {
      expect(loadRuntimeEnv(tmpDir)).toEqual({});
    });

    it('reads KEY=VALUE pairs', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), 'GH_TOKEN=ghs_abc\nAWS_KEY=AKIAxyz\n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({
        GH_TOKEN: 'ghs_abc',
        AWS_KEY: 'AKIAxyz',
      });
    });

    it('ignores comments and blank lines', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), '# comment\n\nGH_TOKEN=ghs_abc\n# another\nAWS_KEY=AKIAxyz\n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({
        GH_TOKEN: 'ghs_abc',
        AWS_KEY: 'AKIAxyz',
      });
    });

    it('trims whitespace', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), '  GH_TOKEN  =  ghs_abc  \n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ GH_TOKEN: 'ghs_abc' });
    });

    it('handles values with = sign', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), 'EQUATION=a=b=c\n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ EQUATION: 'a=b=c' });
    });

    it('strips double quotes from value', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), 'KEY="hello world"\n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'hello world' });
    });

    it('strips single quotes from value', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), "KEY='hello world'\n");
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'hello world' });
    });

    it('does not strip mismatched quotes', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), "KEY=\"hello'\n");
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: "\"hello'" });
    });

    it('unescapes internal escaped double quotes', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), 'KEY="say \\"hi\\""\n');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'say "hi"' });
    });

    it('unescapes internal escaped single quotes', () => {
      fs.writeFileSync(path.join(tmpDir, '.runtime-env'), "KEY='it\\'s here'\n");
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: "it's here" });
    });
  });

  describe('setRuntimeEnv', () => {
    it('creates file and writes key', () => {
      setRuntimeEnv(tmpDir, 'GH_TOKEN', 'ghs_abc');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ GH_TOKEN: 'ghs_abc' });
    });

    it('appends to existing file', () => {
      setRuntimeEnv(tmpDir, 'KEY1', 'val1');
      setRuntimeEnv(tmpDir, 'KEY2', 'val2');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY1: 'val1', KEY2: 'val2' });
    });

    it('overwrites existing key', () => {
      setRuntimeEnv(tmpDir, 'KEY', 'old');
      setRuntimeEnv(tmpDir, 'KEY', 'new');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'new' });
    });

    it('quotes values with spaces', () => {
      setRuntimeEnv(tmpDir, 'MSG', 'hello world');
      const content = fs.readFileSync(path.join(tmpDir, '.runtime-env'), 'utf-8');
      expect(content).toContain('MSG="hello world"');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ MSG: 'hello world' });
    });

    it('quotes and escapes values with double quotes', () => {
      setRuntimeEnv(tmpDir, 'MSG', 'say "hi"');
      const content = fs.readFileSync(path.join(tmpDir, '.runtime-env'), 'utf-8');
      expect(content).toContain('MSG="say \\"hi\\""');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ MSG: 'say "hi"' });
    });

    it('writes simple values without quotes', () => {
      setRuntimeEnv(tmpDir, 'TOKEN', 'ghs_abc123');
      const content = fs.readFileSync(path.join(tmpDir, '.runtime-env'), 'utf-8');
      expect(content).toContain('TOKEN=ghs_abc123');
      expect(content).not.toContain('TOKEN="');
    });
  });

  describe('deleteRuntimeEnv', () => {
    it('removes a key', () => {
      setRuntimeEnv(tmpDir, 'KEY1', 'val1');
      setRuntimeEnv(tmpDir, 'KEY2', 'val2');
      deleteRuntimeEnv(tmpDir, 'KEY1');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY2: 'val2' });
    });

    it('removes file when last key deleted', () => {
      setRuntimeEnv(tmpDir, 'KEY', 'val');
      deleteRuntimeEnv(tmpDir, 'KEY');
      expect(fs.existsSync(path.join(tmpDir, '.runtime-env'))).toBe(false);
    });

    it('does nothing for non-existent key', () => {
      setRuntimeEnv(tmpDir, 'KEY', 'val');
      deleteRuntimeEnv(tmpDir, 'MISSING');
      expect(loadRuntimeEnv(tmpDir)).toEqual({ KEY: 'val' });
    });
  });
});


describe('runtime credential infrastructure boundary', () => {
  it('leaves credential names and lifetime selection to the agent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-policy-'));
    try {
      setRuntimeEnv(dir, 'CUSTOM_PROVIDER_CREDENTIAL', 'synthetic-value', { expiresAt: new Date(Date.now() + 86400000).toISOString() });
      setRuntimeEnv(dir, 'ANOTHER_SERVICE_TOKEN', 'another-value');
      expect(loadRuntimeEnv(dir)).toMatchObject({ CUSTOM_PROVIDER_CREDENTIAL: 'synthetic-value', ANOTHER_SERVICE_TOKEN: 'another-value' });
    } finally {fs.rmSync(dir, { recursive: true, force: true });}
  });
  it('honors declared expiry and rejects explicit process-control injection', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-policy-'));
    try {
      fs.writeFileSync(path.join(dir, '.runtime-env'), 'CUSTOM_TOKEN=secret\nCUSTOM_TOKEN_EXPIRES_AT=2000-01-01T00:00:00Z\nNODE_OPTIONS=unsafe\nSAFE_TOKEN=valid\n');
      expect(loadRuntimeEnv(dir)).toEqual({ SAFE_TOKEN: 'valid' });
      for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'PATH', 'HTTPS_PROXY', 'GIT_SSH_COMMAND']) {
        expect(() => setRuntimeEnv(dir, key, 'unsafe')).toThrow('Unsafe runtime');
      }
      expect(() => setRuntimeEnv(dir, 'TOKEN', 'value\nNODE_OPTIONS=unsafe')).toThrow('Unsafe runtime');
      expect(() => setRuntimeEnv(dir, 'TOKEN', 'value', { expiresAt: 'invalid' })).toThrow('expiry');
    } finally {fs.rmSync(dir, { recursive: true, force: true });}
  });
});

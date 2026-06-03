import { describe, it, beforeEach, afterEach, expect } from 'vitest';
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

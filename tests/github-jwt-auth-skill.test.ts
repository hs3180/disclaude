import fs from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const skill = fs.readFileSync(resolve('skills/github-jwt-auth/SKILL.md'), 'utf8');
const body = skill.slice(skill.indexOf('  // Step D:'), skill.indexOf('  console.log("OK");'));
// Execute the actual skill writer against real files, without GitHub traffic.
const write = new Function('fs', 'crypto', 'RUNTIME_ENV', 'tokenData', 'installId', 'repoFullName', body) as (...args: unknown[]) => void;
const dirs: string[] = [];
function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'jwt-skill-writer-'));
  dirs.push(dir);
  const file = join(dir, '.runtime-env');
  const data = { token: 'ghs_synthetic123456789', expires_at: new Date(Date.now() + 3500000).toISOString() };
  return { dir, file, data, run: (io: typeof fs = fs) => write(io, crypto, file, data, 123, 'owner/repo') };
}
afterEach(() => {for (const dir of dirs.splice(0)) {fs.rmSync(dir, { recursive: true, force: true });}});

describe('GitHub auth skill credential persistence', () => {
  it('writes an expiring derived token atomically with owner-only permissions', () => {
    const { file, dir, run } = setup();
    fs.writeFileSync(file, 'GH_TOKEN=old\n', { mode: 0o644 });
    run();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).toContain('GH_TOKEN_EXPIRES_AT=');
    expect(fs.readdirSync(dir)).toEqual(['.runtime-env']);
  });
  it.each(['symbolic', 'hard'])('rejects a %s link without altering its target', kind => {
    const { file, dir, run } = setup();
    const target = join(dir, 'target');
    fs.writeFileSync(target, 'preserve-me');
    if (kind === 'symbolic') {fs.symlinkSync(target, file);} else {fs.linkSync(target, file);}
    expect(run).toThrow('Unsafe runtime credential target');
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve-me');
  });
  it('preserves the previous credential and removes temporary files on rename failure', () => {
    const { file, dir, run } = setup();
    fs.writeFileSync(file, 'previous');
    expect(() => run({ ...fs, renameSync() {throw new Error('disk failure');} })).toThrow('disk failure');
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir)).toEqual(['.runtime-env']);
  });
  it('rejects expired values and environment-line injection before writing', () => {
    const { file, data, run } = setup();
    data.expires_at = new Date(0).toISOString();
    expect(run).toThrow('Invalid or expired');
    data.expires_at = new Date(Date.now() + 10000).toISOString();
    data.token = 'secret\nNODE_OPTIONS=unsafe';
    expect(run).toThrow('Invalid or expired');
    expect(fs.existsSync(file)).toBe(false);
  });
});

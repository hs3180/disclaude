import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ownedPaths: string[] = [];
afterEach(() => {
  for (const dir of ownedPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { chatId?: string; workdir?: string; pretty?: boolean } = {}) {
  const root = fs.mkdtempSync('/tmp/disclaude-dissolve-test-');
  ownedPaths.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(bin, 'lark-cli'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(process.env.DISSOLVE_FIXTURE_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv.includes('--version')) { console.log('fixture-cli'); process.exit(0); }
const response = JSON.parse(process.env.DISSOLVE_FIXTURE_RESPONSE);
const output = JSON.stringify(response, null, process.env.DISSOLVE_FIXTURE_PRETTY === '1' ? 2 : 0);
(Number(process.env.DISSOLVE_FIXTURE_EXIT) ? process.stderr : process.stdout).write(output);
process.exit(Number(process.env.DISSOLVE_FIXTURE_EXIT));
`, { mode: 0o700 });
  const workdir = options.workdir ?? path.join(root, 'workdir');
  fs.mkdirSync(workdir, { recursive: true });
  fs.writeFileSync(path.join(workdir, 'retain.txt'), 'Owned fixture only');
  const mapping = path.join(root, 'mapping.json');
  const chatId = options.chatId ?? 'oc_fixture064';
  fs.writeFileSync(mapping, JSON.stringify({
    owned: { chatId, purpose: 'Owned fixture', createdAt: '2026-10-10T00:00:00Z', workdir },
    other: { chatId: 'oc_other064', purpose: 'Retain', createdAt: '2026-10-10T00:00:00Z' },
  }));
  return {
    mapping, workdir, chatId,
    run(response: unknown, exitCode = 0, extraEnv: Record<string, string> = {}) {
      return spawnSync(process.execPath, [
        path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('skills/dissolve-group/dissolve-group.ts'),
      ], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
          DISSOLVE_KEY: 'owned', DISSOLVE_CHAT_ID: '', DISSOLVE_SKIP_LARK: '',
          MAPPING_FILE: mapping, DISSOLVE_FIXTURE_CALLS: calls,
          DISSOLVE_FIXTURE_RESPONSE: JSON.stringify(response),
          DISSOLVE_FIXTURE_PRETTY: options.pretty ? '1' : '0',
          DISSOLVE_FIXTURE_EXIT: String(exitCode), ...extraEnv },
      });
    },
    table: () => JSON.parse(fs.readFileSync(mapping, 'utf8')) as Record<string, unknown>,
    calls: () => fs.existsSync(calls)
      ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[])
      : [],
  };
}

describe('dissolve-group native result and cleanup contract', () => {
  it('preserves mapping and workdir when API scopes are missing', () => {
    const f = fixture();
    const result = f.run({ ok: false, error: { code: 99991672, message: 'Access denied: missing scope' } }, 1);
    expect(result.status).not.toBe(0);
    expect(f.table()).toHaveProperty('owned');
    expect(fs.existsSync(f.workdir)).toBe(true);
  });

  it('preserves local state for an exit-zero owner/creator rejection', () => {
    const f = fixture();
    const result = f.run({ ok: false, error: { code: 232017, message: 'No permission' } });
    expect(result.status).not.toBe(0);
    expect(f.table()).toHaveProperty('owned');
    expect(fs.existsSync(f.workdir)).toBe(true);
  });

  it('does not treat malformed success output as native deletion', () => {
    const f = fixture();
    const result = f.run({ unexpected: 'No API success envelope' });
    expect(result.status).not.toBe(0);
    expect(f.table()).toHaveProperty('owned');
  });

  it('accepts native success and calls DELETE rather than removing membership', () => {
    const f = fixture();
    const result = f.run({ ok: true, data: {} });
    expect(result.status).toBe(0);
    expect(f.calls()).toContainEqual(['api', 'DELETE', `/open-apis/im/v1/chats/${f.chatId}`, '--as', 'bot']);
    expect(f.table()).not.toHaveProperty('owned');
    expect(f.table()).toHaveProperty('other');
    expect(fs.existsSync(f.workdir)).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ dissolved: 'yes', workdir: 'cleaned' });
  });

  it('accepts only the structured already-dissolved business code for repeat cleanup', () => {
    const f = fixture({ pretty: true });
    const result = f.run({ ok: false, error: { code: 232009, message: 'Group is dissolved' } }, 1);
    expect(result.status).toBe(0);
    expect(f.table()).not.toHaveProperty('owned');
    expect(fs.existsSync(f.workdir)).toBe(false);
  });

  it('preserves mapping on an invalid or inaccessible ID instead of guessing it is absent', () => {
    const f = fixture();
    const result = f.run({ ok: false, error: { code: 232006, message: 'chat_not_exist' } }, 1);
    expect(result.status).not.toBe(0);
    expect(f.table()).toHaveProperty('owned');
  });

  it('validates the mapped ID before invoking the CLI', () => {
    const f = fixture({ chatId: 'oc_fixture --as user' });
    const result = f.run({ ok: true, data: {} });
    expect(result.status).not.toBe(0);
    expect(f.calls()).toEqual([]);
    expect(f.table()).toHaveProperty('owned');
  });

  it('rejects conflicting explicit ID and mapping key', () => {
    const f = fixture();
    const result = f.run({ ok: true, data: {} }, 0, { DISSOLVE_CHAT_ID: 'oc_different064' });
    expect(result.status).not.toBe(0);
    expect(f.calls()).toEqual([]);
    expect(f.table()).toHaveProperty('owned');
  });

  it('cannot escape the temporary root through a prefixed traversal path', () => {
    const outside = fs.mkdtempSync(path.join(process.cwd(), 'dissolve-owned-outside-'));
    ownedPaths.push(outside);
    const f = fixture({ workdir: '/tmp/../../' + outside.slice(1) });
    const result = f.run({ ok: true, data: {} });
    expect(result.status).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
    expect(JSON.parse(result.stdout).workdir).toBe('skipped');
  });

  it('reports an explicit simulation without claiming native dissolution', () => {
    const f = fixture();
    const result = f.run({ ok: true, data: {} }, 0, { DISSOLVE_SKIP_LARK: '1' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).dissolved).toBe('skipped');
    expect(f.calls()).not.toContainEqual(['api', 'DELETE', `/open-apis/im/v1/chats/${f.chatId}`, '--as', 'bot']);
  });

  it('preserves a directory reached through an intermediate symlink outside /tmp', () => {
    const outside = fs.mkdtempSync(path.join(process.cwd(), 'dissolve-owned-link-target-'));
    const links = fs.mkdtempSync('/tmp/disclaude-dissolve-link-');
    ownedPaths.push(outside, links);
    fs.symlinkSync(outside, path.join(links, 'alias'), 'dir');
    const f = fixture({ workdir: path.join(links, 'alias', 'child') });
    const result = f.run({ ok: true, data: {} });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(outside, 'child', 'retain.txt'))).toBe(true);
    expect(JSON.parse(result.stdout).workdir).toBe('skipped');
  });
});

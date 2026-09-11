import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { discoverBuiltinResources } from '../../packages/core/src/sdk/providers/codex/builtin-adapter.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'external-skill-'));
  directories.push(dir);
  return dir;
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [resolve('skills/skill-creator/scripts/create-skill.mjs'), ...args], { encoding: 'utf8' });
}

it('creates a discoverable external skill with YAML-safe metadata', () => {
  const root = temp();
  const result = run('team-tool', join(root, 'skills'), 'Query: "team" resources', '/opt/team tools/client');
  expect(result.status).toBe(0);
  const file = join(JSON.parse(result.stdout).path, 'SKILL.md');
  const content = readFileSync(file, 'utf8');
  const metadata = parse(content.split('---')[1]);
  expect(metadata).toMatchObject({ name: 'team-tool', description: 'Query: "team" resources' });
  expect(discoverBuiltinResources(root).map(item => item.name)).toContain('team-tool');
});

it('does not overwrite an existing skill', () => {
  const root = temp();
  expect(run('team-tool', root, 'Read team resources', 'team-cli').status).toBe(0);
  const file = join(root, 'team-tool/SKILL.md');
  const original = readFileSync(file, 'utf8');
  expect(run('team-tool', root, 'Changed purpose', 'other-cli').status).toBe(1);
  expect(readFileSync(file, 'utf8')).toBe(original);
});

it('generates a runnable help command for an executable path containing spaces and quotes', () => {
  const root = temp();
  const executable = join(root, "team's CLI");
  writeFileSync(executable, '#!/bin/sh\nprintf "external CLI help"\n', { mode: 0o700 });
  const result = run('team-tool', root, 'Use team resources', executable);
  expect(result.status).toBe(0);
  const content = readFileSync(join(root, 'team-tool/SKILL.md'), 'utf8');
  const command = content.split('~~~sh\n')[1].split('\n~~~')[0];
  const help = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
  expect(help.status).toBe(0);
  expect(help.stdout).toBe('external CLI help');
});

it('rejects paths as skill names and multiline metadata', () => {
  const root = temp();
  expect(run('../escape', root, 'Purpose', 'tool').status).toBe(1);
  expect(run('team-tool', root, 'Purpose\nother: value', 'tool').status).toBe(1);
});

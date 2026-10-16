import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => {for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true });}});

it('uses the public CLI outside the checkout and reports invalid or unsafe operations as failures', () => {
  const project = mkdtempSync(join(tmpdir(), 'diagnostics-cli project-'));
  roots.push(project);
  const cli = resolve('bin/disclaude.js');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, 'plugins', ...args], {
    cwd: project, encoding: 'utf8', timeout: 10_000,
  });
  for (const args of [['install', 'unknown'], ['install', 'diagnostics', '--project-dir'], ['install', 'diagnostics', '--extra'], ['upgrade']]) {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  }
  expect(JSON.parse(run(['install', 'diagnostics']).stdout)).toMatchObject({ ok: true, data: { installed: true } });
  const skill = join(project, '.disclaude/plugins/diagnostics/skills/diagnose-logs/SKILL.md');
  writeFileSync(skill, 'user edits');
  const result = run(['remove', 'diagnostics']);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { message: expect.stringContaining('Modified') } });
  expect(readFileSync(skill, 'utf8')).toBe('user edits');
});

import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../bin/disclaude.js', import.meta.url));

describe('record-task public CLI', () => {
  it('executes the generated runtime-pinned guidance without a global disclaude on PATH', async () => {
    const workspace = await mkdtemp(join(tmpdir(), "record guidance ' space-"));
    try {
      const guidanceScript = `import { buildTaskRecordGuidance } from ${JSON.stringify(new URL('../packages/core/dist/agents/message-builder/guidance.js', import.meta.url).href)}; console.log(buildTaskRecordGuidance());`;
      const guidance = spawnSync(process.execPath, ['--input-type=module', '-e', guidanceScript], { encoding: 'utf8' });
      expect(guidance.status).toBe(0);
      const command = guidance.stdout.match(/```sh\n([\s\S]*?)\n```/)?.[1];
      expect(command).toBeDefined();
      const result = spawnSync('/bin/sh', ['-c', command!], {
        cwd: workspace, env: { ...process.env, PATH: '', DISCLAUDE_WORKSPACE_DIR: workspace }, encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(await readFile(JSON.parse(result.stdout).file, 'utf8')).toContain('## YYYY-MM-DD Brief task description');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('preserves complete records from concurrent project processes on first and later writes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'record-cli-'));
    try {
      const projects = [join(workspace, 'a'), join(workspace, 'b')];
      await Promise.all(projects.map(project => mkdir(project)));
      await mkdir(join(workspace, '.claude'));
      const legacy = join(workspace, '.claude/task-records.md');
      await writeFile(legacy, 'legacy history must remain unchanged');
      const entries = Array.from({ length: 16 }, (_, i) => `## Record ${i}\n\n${'中文 record '.repeat(400)}\nEND ${i}`);
      for (const wave of [entries.slice(0, 8), entries.slice(8)]) {
        const children = wave.map((entry, i) => {
          const child = spawn(process.execPath, [cli, 'record-task', 'append', '2026-09'], {
            cwd: projects[i % 2], env: { ...process.env, DISCLAUDE_WORKSPACE_DIR: workspace },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', data => { stdout += String(data); });
          child.stderr.on('data', data => { stderr += String(data); });
          const closed = once(child, 'close');
          return { child, entry, closed, output: () => ({ stdout, stderr }) };
        });
        for (const { child, entry } of children) child.stdin.end(entry);
        const results = await Promise.all(children.map(async ({ closed, output }) => ({ code: (await closed)[0], ...output() })));
        for (const result of results) {
          expect(result.stderr).toBe('');
          expect(result.code).toBe(0);
          expect(JSON.parse(result.stdout)).toEqual({ ok: true, file: join(workspace, 'task-records/2026-09.md') });
        }
      }
      const body = await readFile(join(workspace, 'task-records/2026-09.md'), 'utf8');
      expect(body.startsWith('# Task Records\n')).toBe(true);
      expect(body.match(/^# Task Records$/gm)).toHaveLength(1);
      for (const entry of entries) expect(body.split(entry)).toHaveLength(2);
      expect(await readdir(join(workspace, 'task-records'))).toEqual(['2026-09.md']);
      for (const project of projects) expect(await readdir(project)).toEqual([]);
      expect(await readFile(legacy, 'utf8')).toBe('legacy history must remain unchanged');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('rejects invalid input without creating or changing records', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'record-cli-invalid-'));
    try {
      for (const [month, input, root] of [
        ['../../escape', 'entry', workspace],
        ['2026-13', 'entry', workspace],
        ['2026-09', ' ', workspace],
        ['2026-09', 'x'.repeat(65537), workspace],
        ['2026-09', 'entry', ''],
        ['2026-09', 'entry', 'relative'],
      ]) {
        const result = spawnSync(process.execPath, [cli, 'record-task', 'append', month], {
          cwd: workspace, env: { ...process.env, DISCLAUDE_WORKSPACE_DIR: root }, input,
          encoding: 'utf8', timeout: 10_000,
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toBe('');
      }
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

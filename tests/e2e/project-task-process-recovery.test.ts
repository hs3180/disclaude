import { expect, it } from 'vitest';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Config } from '@disclaude/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResearchProject } from '../../packages/service/src/research/project.js';
type ProcessMessage = { kind: string; task: ResearchProject; runs?: number };

// Real separate processes and on-disk store; controlled task execution and card
// transport. This does not establish model descendant cleanup or live Feishu UX.
it.skipIf(process.platform === 'win32')('recovers a killed task owner and applies new feedback without replaying committed work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-process-recovery-'));
  const children: Array<{ child: ChildProcess; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }> = [];
  const source = `
import { ResearchManager } from ${JSON.stringify(pathToFileURL(resolve('packages/service/dist/research/manager.js')).href)};
import { ProjectStore } from ${JSON.stringify(pathToFileURL(resolve('packages/service/dist/research/project.js')).href)};
const root = process.env.TASK_RECOVERY_ROOT;
const phase = process.env.TASK_RECOVERY_PHASE;
let runs = 0;
const runner = async p => {
  runs++;
  if (phase === 'first') {
    if (runs === 1) return { state: 'continue', message: 'Initial evidence saved', work: [
      { title: 'Initial observation', status: 'done', findings: [{ claim: 'Initial observation retained', kind: 'fact', sources: [{ title: 'Fixture', location: 'fixture://initial', excerpt: 'Initial observation retained' }], caveat: '' }] }
    ], feedback: [], questions: [] };
    process.send({ kind: 'inflight', task: p });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  if (p.directions.length !== 1 || p.directions[0].status !== 'done' || p.feedback[0]?.text !== 'Check the new observation') throw new Error('Recovered context lost');
  return { state: 'complete', message: 'Applied new feedback', work: [{ title: 'New observation', status: 'done', findings: [] }],
    feedback: [{ feedbackIndex: 0, status: 'applied', reason: 'Checked the new observation', workIndexes: [0] }], questions: [], summary: 'Initial and new observations retained' };
};
const manager = new ResearchManager(new ProjectStore(root + '/store'), runner, async () => 'captured-card');
if (phase === 'first') {
  const p = await manager.create({ owner: 'alice', chat: 'chat', source: 'request', workingDir: root, title: 'Observe then check feedback', scope: '', materials: '' });
  await manager.act(p.id, p.owner, p.chat, p.revision, 'resume');
  await manager.idle(p.id);
} else {
  const p = manager.list('alice', 'chat')[0];
  process.send({ kind: 'recovered', task: p });
  await manager.act(p.id, p.owner, p.chat, p.revision, 'feedback', 'Check the new observation');
  await manager.act(p.id, p.owner, p.chat, manager.get(p.id, p.owner, p.chat).revision, 'resume');
  await manager.idle(p.id);
  process.send({ kind: 'finished', task: manager.get(p.id, p.owner, p.chat), runs });
  manager.dispose();
  process.disconnect();
}
`;
  const start = (phase: string) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TASK_RECOVERY_ROOT: root, TASK_RECOVERY_PHASE: phase }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const messages: ProcessMessage[] = [];
    child.on('message', message => { messages.push(message as ProcessMessage); });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
      child.once('error', error => { clearTimeout(deadline); fail(error); });
      child.once('close', (code, signal) => { clearTimeout(deadline); done({ code, signal }); });
    });
    children.push({ child, exited });
    return { child, exited, messages, stderr: () => stderr };
  };
  try {
    const first = start('first');
    await expect.poll(() => first.messages.find(m => m.kind === 'inflight'), { timeout: 10_000 }).toBeTruthy();
    const checkpoint = first.messages.find(m => m.kind === 'inflight')!.task;
    expect(checkpoint.directions).toHaveLength(1);
    const competing = start('probe');
    expect((await competing.exited).code).toBe(1);
    expect(competing.stderr()).toContain('另一个服务正在使用任务存储');
    expect(first.child.exitCode).toBeNull();
    expect(first.child.signalCode).toBeNull();
    expect(first.child.kill('SIGKILL')).toBe(true);
    expect(await first.exited).toEqual({ code: null, signal: 'SIGKILL' });
    const second = start('second');
    expect(await second.exited, second.stderr()).toEqual({ code: 0, signal: null });
    const reopened = second.messages.find(m => m.kind === 'recovered')!.task;
    expect(reopened.status).toBe('interrupted');
    expect(reopened.directions).toEqual(checkpoint.directions);
    const finished = second.messages.find(m => m.kind === 'finished')!;
    expect(finished.task.status).toBe('completed');
    expect(finished.runs).toBe(1);
    expect(finished.task.directions).toHaveLength(2);
    expect(finished.task.directions[0]).toEqual(checkpoint.directions[0]);
    expect(finished.task.feedback[0].status).toBe('applied');
    expect(finished.task.workingDir).toBe(root);
  } finally {
    // These children run controlled JS only and do not create descendants.
    for (const { child, exited } of children) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); }
      await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, 30_000);

// Requires current compiled packages and actual configured model credentials.
// Captured card transport: no production service or chat connection is started.
it.skipIf(
  process.env.DISCLAUDE_E2E_TASK_HARNESS !== '1' ||
    Config.AGENT_BACKEND !== 'codex' ||
    process.platform === 'win32'
)(
  'recovers a real model task after owner SIGKILL and reads updated material',
  async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['tests/e2e/helpers/task-crash-acceptance.mjs'],
      {
        cwd: resolve('.'),
        timeout: 250_000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    const line = stdout.split('\n').find((line) => line.startsWith('REAL_CRASH_RESUME_RESULT '));
    expect(line, stdout).toBeTruthy();
    const evidence = JSON.parse(line!.slice('REAL_CRASH_RESUME_RESULT '.length));
    expect(evidence.remainingAfterCrash).toEqual([]);
    expect(evidence.manualRemediation).toBe(false);
    expect(evidence.resumed).toMatchObject({
      id: evidence.taskId,
      status: 'completed',
      feedback: 'applied',
    });
    expect(stdout).toContain('ROOT_RECLAIMED');
    console.info(line);
  },
  270_000
);

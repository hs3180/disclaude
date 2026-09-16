import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Config, setDefaultProvider, clearProviderCache } from '@disclaude/core';
import { HttpApiServer } from '../../packages/service/src/http-api-server.js';
import { projectTaskGateway } from '../../packages/service/src/harness/project-task-gateway.js';
import { FeishuResearchController } from '../../packages/service/src/research/feishu-controller.js';
import { AgentFactory } from '../../packages/service/src/agents/factory.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'project-task-api-e2e-'));
  const namespace = randomUUID();
  const apiToken = randomUUID();
  const server = new HttpApiServer({ host: '127.0.0.1', port: 0, apiToken });
  const controller = new FeishuResearchController(join(root, 'store'), root, async () => 'captured-task-card', async () => {},
    undefined, undefined, undefined, async () => root);
  try { await server.start(); }
  catch (error) { controller.dispose(); await rm(root, { recursive: true, force: true }); throw error; }
  const url = `http://127.0.0.1:${server.getAddress()?.port}`;
  const issue = (owner: string) => projectTaskGateway.issue(namespace, operation => controller.executeTask({ owner, chat: 'test-chat', source: 'test-message' }, operation));
  const context = issue('alice');
  return { root, namespace, apiToken, server, controller, url, context, issue,
    async cleanup(retain = false) {
      projectTaskGateway.revoke(namespace);
      try { controller.dispose(); await server.stop(); clearProviderCache(); }
      catch (error) { console.error(`Task API test files retained at ${root}: teardown failed`); throw error; }
      if (retain) { console.error(`Task API test files retained at ${root}: model termination unconfirmed`); }
      else { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    } };
}
async function cli(f: Awaited<ReturnType<typeof fixture>>, operation: unknown, context = f.context, extra: string[] = []) {
  const child = spawn(process.execPath, [resolve('bin/disclaude.js'), 'channel', 'project_task', '--context', context, ...extra], {
    env: { ...process.env, DISCLAUDE_API_BASE_URL: f.url, DISCLAUDE_API_TOKEN: f.apiToken }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(JSON.stringify(operation));
  const exitCode = await new Promise<number | null>((done, fail) => { child.once('close', done); child.once('error', fail); });
  expect(stdout).not.toContain(f.apiToken); expect(stderr).not.toContain(f.apiToken);
  expect(stdout).not.toContain(context);
  return { exitCode, result: JSON.parse(stdout.trim()), stderr };
}

it('creates and controls project tasks through the real authenticated CLI while retaining actor boundaries', async () => {
  const f = await fixture();
  try {
    const request = { action: 'create', requestId: 'first', title: 'Inspect logs', materials: 'Supplied logs' };
    const created = await cli(f, request);
    expect(created.exitCode, created.stderr).toBe(0);
    const task = created.result.data.task;
    expect(task).toMatchObject({ owner: 'alice', chat: 'test-chat', status: 'paused', workingDir: f.root });
    expect((await cli(f, request)).result.data.task.id).toBe(task.id);
    expect((await cli(f, { action: 'get', taskId: task.id }, f.issue('bob'))).exitCode).toBe(1);
    expect((await cli(f, { ...request, owner: 'bob' })).exitCode).toBe(1);
    expect((await cli(f, { action: 'list' }, f.context, ['--chat', 'other-chat'])).result.error).toContain('Unknown option');
    const cancelled = await cli(f, { action: 'control', taskId: task.id, revision: task.revision, control: 'cancel' });
    expect(cancelled.result.data.task.status).toBe('cancelled');
    const listed = await cli(f, { action: 'list' });
    expect(listed.result.data.tasks).toHaveLength(1);
    expect((await cli(f, { action: 'control', taskId: task.id, revision: task.revision, control: 'archive' })).exitCode).toBe(1);
    expect((await cli(f, { action: 'control', taskId: task.id, revision: cancelled.result.data.task.revision, control: 'archive' })).exitCode).toBe(0);
    expect((await cli(f, { action: 'list' })).result.data.tasks).toHaveLength(0);
    expect((await cli(f, { action: 'list', archived: true, limit: 1 })).result.data.tasks).toHaveLength(1);
    projectTaskGateway.revoke(f.namespace);
    expect((await cli(f, { action: 'list' })).exitCode).toBe(1);
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.env.DISCLAUDE_E2E_TASK_HARNESS !== '1')('lets an ordinary model create and start a persistent task from a natural-language request', async () => {
  const f = await fixture();
  const filename = `inventory-${randomUUID()}.txt`;
  const marker = `observed-${randomUUID()}`;
  const previousUrl = process.env.DISCLAUDE_API_BASE_URL, previousToken = process.env.DISCLAUDE_API_TOKEN;
  let agent: ReturnType<typeof AgentFactory.createAgent> | undefined;
  let mayBeRunning = false;
  try {
    process.env.DISCLAUDE_API_BASE_URL = f.url; process.env.DISCLAUDE_API_TOKEN = f.apiToken;
    setDefaultProvider(Config.AGENT_BACKEND);
    await writeFile(join(f.root, filename), `Inventory identifier: ${marker}. Count: 17.\n`);
    let turnSucceeded = false;
    agent = AgentFactory.createAgent('ordinary-task-request', { sendMessage: async () => {}, sendCard: async () => {}, sendFile: async () => {},
      onTurnResult: async result => { turnSucceeded = result.success && !result.truncated; } }, { skipHistory: true, cwdProvider: () => f.root });
    mayBeRunning = true;
    await agent.runOnce('ordinary-task-request', `Create and start a persistent project task to read ${filename} in its project directory and report the exact inventory identifier and count. The task must only read that file; no external sources or file edits. Do not perform the inventory check yourself. Return the created task ID after starting it. Keep any temporary CLI request files inside this working directory. Test environment: use the checkout CLI via node ${JSON.stringify(resolve('bin/disclaude.js'))} channel in place of the globally installed disclaude channel executable.`, 'user-request', 'alice', { projectTaskContext: f.context });
    expect(turnSucceeded).toBe(true);
    const tasks = f.controller.manager.list('alice', 'test-chat');
    expect(tasks).toHaveLength(1);
    await f.controller.manager.idle(tasks[0].id);
    const done = f.controller.manager.get(tasks[0].id, 'alice', 'test-chat');
    mayBeRunning = done.status !== 'completed';
    expect(done.status, done.error).toBe('completed');
    expect(done.summary).toContain(marker); expect(done.summary).toContain('17');
    expect(await readFile(join(f.root, filename), 'utf8')).toBe(`Inventory identifier: ${marker}. Count: 17.\n`);
    console.info('NATURAL_LANGUAGE_TASK_CREATED', { id: done.id, status: done.status, summary: done.summary });
  } finally {
    agent?.dispose();
    if (previousUrl === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; } else { process.env.DISCLAUDE_API_BASE_URL = previousUrl; }
    if (previousToken === undefined) { delete process.env.DISCLAUDE_API_TOKEN; } else { process.env.DISCLAUDE_API_TOKEN = previousToken; }
    await f.cleanup(mayBeRunning);
  }
}, 240_000);

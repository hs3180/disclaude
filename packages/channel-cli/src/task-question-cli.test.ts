import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chatId = 'oc_0123456789012345678901234567890123';
const question = 'Which release branch should the Goal target: release/0.6 or main?';
const record = { id: 'question-1', taskKey: 'goal-1', question, chatId, actorId: 'ou_actor', sourceMessageId: 'om_source', projectRoot: '/project/a' };
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {await new Promise<void>(done => server.close(() => done()));}
  for (const dir of dirs.splice(0)) {rmSync(dir, { recursive: true, force: true });}
});
async function fixture(status = 200) {
  const requests: Array<{ path?: string; token?: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {res.end(JSON.stringify({ pong: true })); return;}
    let body = '';
    for await (const chunk of req) {body += chunk;}
    requests.push({ path: req.url, token: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { ok: true, record }
      : status === 409 ? { ok: false, reason: 'rejected', message: 'No live Goal turn of this user and Project admits this task question' }
        : { ok: false, message: 'Unauthorized' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); servers.push(server);
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
async function cli(args: string[], url: string, stdin = '') {
  const child = spawn(process.execPath, [resolve('bin/disclaude.js'), 'channel', 'task_question_ask', '--chat', chatId, ...args], {
    env: { ...process.env, DISCLAUDE_API_BASE_URL: url, DISCLAUDE_API_TOKEN: 'test-api-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => {stdout += chunk;}); child.stderr.on('data', chunk => {stderr += chunk;});
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((done, reject) => {child.once('error', reject); child.once('close', done);});
  const lines = stdout.trim().split('\n');
  expect(lines, stderr).toHaveLength(1);
  return { code, result: JSON.parse(lines[0]), stderr };
}
const context = ['--actor', 'ou_actor', '--source', 'om_source', '--project-root', '/project/a'];

describe('disclaude channel task_question_ask', () => {
  it.each(['file', 'stdin', 'flag'])('delivers a %s question through the authenticated channel client', async input => {
    const f = await fixture();
    const args = [...context];
    if (input === 'file') {
      const dir = mkdtempSync(join(tmpdir(), 'task-question-cli-')); dirs.push(dir);
      const file = join(dir, 'question with spaces.txt'); writeFileSync(file, question);
      args.push('--question-file', file);
    } else if (input === 'flag') { args.push('--question', question); }
    const result = await cli(args, f.url, input === 'stdin' ? question : '');
    expect(result.code).toBe(0);
    expect(result.result).toMatchObject({ ok: true, command: 'task_question_ask', questionId: 'question-1', chatId });
    expect(result.result.result).toBe('Task question card requested');
    expect(f.requests).toEqual([{ path: '/api/task-questions', token: 'Bearer test-api-token', body: {
      chatId, actorId: 'ou_actor', sourceMessageId: 'om_source', projectRoot: '/project/a', question,
      goalId: undefined, threadRootId: undefined, replyRootId: undefined,
    } }]);
    // The card record and question text stay on the service side; the CLI result carries only the id.
    expect(JSON.stringify(result.result)).not.toContain('release/0.6');
    expect(result.stderr).not.toContain('test-api-token');
  });
  it('forwards --goal, --parent and --thread-root as the narrowing and reply fields', async () => {
    const f = await fixture();
    const result = await cli([...context, '--question', question, '--goal', 'goal-1', '--parent', 'om_trigger', '--thread-root', 'om_topic'], f.url);
    expect(result.code).toBe(0);
    expect(f.requests[0].body).toMatchObject({ goalId: 'goal-1', replyRootId: 'om_trigger', threadRootId: 'om_topic' });
  });
  it('reports a refused admission with the host verdict instead of a network hint', async () => {
    const f = await fixture(409);
    const result = await cli([...context, '--question', question], f.url);
    expect(result.code).toBe(1); expect(result.result.ok).toBe(false);
    expect(result.result.error).toContain('No live Goal turn of this user and Project admits this task question');
    expect(result.result.hint).toBeUndefined();
  });
  it('returns nonzero on rejected authentication', async () => {
    const f = await fixture(401);
    const result = await cli([...context, '--question', question], f.url);
    expect(result.code).toBe(1); expect(result.result.ok).toBe(false);
    expect(result.result.error).toContain('Unauthorized');
  });
  it('rejects missing context, malformed fields and unknown flags before any request', async () => {
    const f = await fixture();
    expect((await cli(['--question', question], f.url)).result.error).toContain('--actor');
    expect((await cli(['--actor', 'ou_actor', '--source', 'om_source', '--project-root', 'relative/dir', '--question', question], f.url)).result.error).toContain('absolute path');
    expect((await cli([...context, '--goal', ' ', '--question', question], f.url)).result.error).toContain('--goal');
    expect((await cli([...context, '--question', '   '], f.url)).result.error).toContain('Missing question content');
    expect((await cli([...context, '--answer', 'main'], f.url)).result.error).toContain('Unknown option: --answer');
    expect((await cli([...context, '--question', question, '--parent', 'sched-owned-task'], f.url)).result.error).toContain('Internal tracking IDs');
    expect(f.requests).toHaveLength(0);
  });
  it('does not execute a dry-run', async () => {
    const f = await fixture();
    const result = await cli([...context, '--question', question, '--goal', 'goal-1', '--parent', 'om_trigger', '--dry-run'], f.url);
    expect(result.code).toBe(0);
    expect(result.result).toMatchObject({ ok: true, command: 'task_question_ask', dryRun: true, validation: 'local-input' });
    // Fields the caller omitted are not sent: the service reads them as absent, not as empty strings.
    expect(result.result.payload).toEqual({
      chatId, actorId: 'ou_actor', sourceMessageId: 'om_source', projectRoot: '/project/a', question, goalId: 'goal-1', replyRootId: 'om_trigger',
    });
    expect(f.requests).toHaveLength(0);
  });
});

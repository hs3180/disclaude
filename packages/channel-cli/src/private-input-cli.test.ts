import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const chatId = 'oc_0123456789012345678901234567890123';
const workflow = { title: 'Task workflow', description: 'Task-defined private use', command: '/agent/consumer', args: ['task'] };
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
    res.end(JSON.stringify(status === 200 ? { ok: true, actionId: 'task-action' } : { ok: false, message: 'Unauthorized' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); servers.push(server);
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests };
}
async function cli(args: string[], url: string, stdin = '') {
  const child = spawn(process.execPath, [resolve('bin/disclaude.js'), 'channel', 'request_private_input', '--chat', chatId, ...args], {
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

describe('disclaude channel request_private_input', () => {
  it.each(['file', 'stdin'])('delivers a %s definition through the authenticated channel client', async input => {
    const f = await fixture();
    const args = ['--actor', 'ou_actor', '--source', 'om_source'];
    if (input === 'file') {
      const dir = mkdtempSync(join(tmpdir(), 'private-cli-')); dirs.push(dir);
      const file = join(dir, 'workflow with spaces.json'); writeFileSync(file, JSON.stringify(workflow));
      args.push('--workflow-file', file);
    }
    const result = await cli(args, f.url, input === 'stdin' ? JSON.stringify(workflow) : '');
    expect(result.code).toBe(0);
    expect(result.result).toMatchObject({ ok: true, command: 'request_private_input', actionId: 'task-action', chatId });
    expect(f.requests).toEqual([{ path: '/api/private-workflows', token: 'Bearer test-api-token', body: {
      chatId, actorId: 'ou_actor', sourceMessageId: 'om_source', workflow,
    } }]);
    expect(JSON.stringify(result.result)).not.toContain('/agent/consumer');
    expect(result.stderr).not.toContain('test-api-token');
  });
  it('returns nonzero on rejected authentication', async () => {
    const f = await fixture(401);
    const result = await cli(['--actor', 'ou_actor', '--source', 'om_source', '--workflow', JSON.stringify(workflow)], f.url);
    expect(result.code).toBe(1); expect(result.result.ok).toBe(false);
    expect(result.result.error).toContain('Unauthorized');
  });
  it('rejects missing context and malformed workflows before any request', async () => {
    const f = await fixture();
    expect((await cli(['--workflow', '{}'], f.url)).result.error).toContain('--actor');
    expect((await cli(['--actor', 'ou_actor', '--source', 'om_source', '--workflow', '[]'], f.url)).result.error).toContain('Workflow must be an object');
    expect(f.requests).toHaveLength(0);
  });
});

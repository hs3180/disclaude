// Built CLI subprocesses against an owned endpoint. Help/dry-run must never connect.
// Run after pnpm run build: node tests/integration/channel-cli-preview.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = await mkdtemp(join(tmpdir(), 'disclaude-channel-preview-'));
const cli = fileURLToPath(new URL('../../packages/channel-cli/dist/cli.js', import.meta.url));
const requests = [];
let connections = 0;
const server = createServer((request, response) => {
  requests.push({ method: request.method, path: request.url }); request.resume();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, pong: true, success: true }));
});
server.on('connection', () => { connections++; });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const chat = 'oc_0123456789012345678901234567890123';
const cases = [];
async function run(args, stdin = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: 'pipe',
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', LOG_LEVEL: 'fatal', LOG_TO_FILE: 'false',
        DISCLAUDE_API_BASE_URL: endpoint } });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned CLI fixture timed out')); }, 10_000);
    child.stdout.on('data', data => { stdout += String(data); });
    child.stderr.on('data', data => { stderr += String(data); });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
  });
}
try {
  for (const command of ['send_text', 'send_file', 'send_card', 'push', 'send_interactive', 'request_private_input']) {
    const result = await run([command, '--help']);
    assert.equal(result.code, 0); assert.match(result.stdout, new RegExp(`Usage: disclaude channel ${command}`));
    cases.push({ name: command + '-help', passed: true });
  }
  const options = [{ text: '修正两处（报告+表格）', value: 'fix', type: 'primary' }];
  const prompts = { fix: '[用户操作] 修正两处，继续原任务' };
  const optionFile = join(root, 'options.json'); const promptFile = join(root, 'prompts.json');
  await writeFile(optionFile, JSON.stringify(options)); await writeFile(promptFile, JSON.stringify(prompts));
  const common = ['send_interactive', '--dry-run', '--chat', chat, '--question', '下一步？',
    '--api-token', 'owned-preview-only-token', '--parent', 'om_source', '--thread-root', 'om_topic',
    '--idempotency-key', 'followup:om_source'];
  for (const [name, flags, stdin] of [
    ['json-files', ['--options-file', optionFile, '--action-prompts-file', promptFile], ''],
    ['options-stdin', ['--options-file', '-', '--action-prompts-file', promptFile], JSON.stringify(options)],
    ['prompts-stdin', ['--options-file', optionFile, '--action-prompts-file', '-'], JSON.stringify(prompts)],
  ]) {
    const result = await run([...common, ...flags], stdin); assert.equal(result.code, 0, result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.payload.options, options); assert.deepEqual(parsed.payload.actionPrompts, prompts);
    assert.equal(parsed.payload.threadRootId, 'om_topic'); assert.equal(parsed.payload.parentMessageId, 'om_source');
    assert.equal(parsed.decodedPreview.options[0].text, options[0].text);
    assert.equal(result.stdout.includes('owned-preview-only-token'), false);
    cases.push({ name, passed: true });
  }
  const bad = await run([...common.filter(value => value !== '--dry-run'), '--options', JSON.stringify([{ text: String.raw`\u4fee\u6b63\u4e24\u5904`, value: 'fix' }]),
    '--action-prompts-file', promptFile]);
  assert.equal(bad.code, 1); assert.match(JSON.parse(bad.stdout).error, /double-escaped JSON/);
  cases.push({ name: 'double-escape-rejected', passed: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 0); assert.deepEqual(requests, []);
  console.log(JSON.stringify({ channelPreviewFixture: { passed: true, cases, networkConnections: connections,
    requests, actualDeliveries: 0, channelConnections: 0, externalModelInputs: 0 } }));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

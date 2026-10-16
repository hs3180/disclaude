// Owned HTTP protocol fixture only. No configured Jupyter, kernel, Python or channels.
// Run after pnpm run build: node tests/integration/jupyter-diagnostics.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = await mkdtemp(join(tmpdir(), 'disclaude-jupyter-diagnostics-'));
const workspace = join(root, 'workspace'), project = join(workspace, 'project'), cwd = join(project, 'nested');
const unconfigured = join(root, 'unconfigured');
await mkdir(cwd, { recursive: true }); await mkdir(unconfigured); await mkdir(join(workspace, '.disclaude'));
await writeFile(join(workspace, '.disclaude', 'project-bindings.json'), '{}');
const secret = 'owned-jupyter-fixture-token';
const requests = [];
let mode = 'normal';
const server = createServer((request, response) => {
  const route = new URL(request.url, 'http://owned.invalid').pathname.replace(/^\/remote\//, '');
  requests.push({ method: request.method, route }); request.resume();
  assert.equal(request.headers.authorization, `token ${secret}`);
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (route === 'api' && mode === 'denied') return json(401, { message: `Denied ${secret}` });
  if (route === 'api' && mode === 'bad-json') { response.writeHead(200); response.end(`not JSON ${secret}`); return; }
  if (route === 'api') return json(200, { version: '2.18.2' });
  if (/^api\/kernels\/[^/]+\/execute$/.test(route)) return json(200, { kernel_id: route.split('/')[2], requests: [] });
  if (route === 'lab') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<script id="jupyter-config-data">{"disableRTC":false,"serverSideExecution":true}</script>'); return; }
  if (route === 'api/nbconvert') return json(200, { html: {} });
  if (route.startsWith('api/contents/')) return json(404, { message: `Parent directory is missing; ${secret}`, token: secret });
  return json(404, { message: 'Owned unknown route' });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/remote/`;
await writeFile(join(workspace, '.env'), `JUPYTERLAB_HOST=${endpoint}\nJUPYTERLAB_TOKEN=${secret}\n`, { mode: 0o600 });
const cli = fileURLToPath(new URL('../../bin/disclaude.js', import.meta.url));
async function invoke(command, extra = [], directory = cwd, projectDir = project) {
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'jupyter', command, '--project-dir', projectDir, '--no-interactive', ...extra], {
      cwd: directory, stdio: 'pipe', env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'test', LOG_LEVEL: 'fatal', LOG_TO_FILE: 'false' },
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned diagnostic CLI timed out')); }, 12_000);
    child.stdout.on('data', data => { stdout += String(data); }); child.stderr.on('data', data => { stderr += String(data); });
    child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end();
  });
  assert.equal(output.stdout.trim().split('\n').length, 1, output.stdout);
  assert.equal((output.stdout + output.stderr).includes(secret), false);
  assert.equal(output.stderr.includes('Configuration file loaded'), false);
  return { ...output, json: JSON.parse(output.stdout) };
}
const cases = [];
try {
  const missingList = await invoke('list', [], unconfigured, unconfigured);
  assert.equal(missingList.code, 0); assert.equal(missingList.json.scope, 'project-local-references');
  assert.equal(missingList.json.auth.state, 'unresolved'); assert.equal(missingList.json.data.remoteInventory, 'not_queried');
  assert.equal(requests.length, 0); cases.push('offline-list-auth-unresolved');
  const configuredList = await invoke('list');
  assert.equal(configuredList.code, 0); assert.equal(configuredList.json.auth.authentication, 'not_checked');
  assert.equal(configuredList.json.credentials.envFile, join(workspace, '.env'));
  assert.equal(requests.length, 0); cases.push('workspace-env-local-list');
  const checked = await invoke('check', ['--verbose']);
  assert.equal(checked.code, 0, checked.stdout); assert.equal(checked.json.data.productAcceptance, 'not_verified');
  assert.equal(checked.json.data.nbmodel.state, 'available'); assert.equal(checked.json.data.rtc.state, 'configured');
  assert.ok(checked.stderr.includes('"phase":"http"')); cases.push('safe-check-phases');
  const created = await invoke('create', ['--path', 'research/missing.ipynb', '--verbose']);
  assert.equal(created.code, 6, created.stdout); assert.equal(created.json.error.layer, 'http');
  assert.equal(created.json.error.status, 404); assert.match(created.json.error.serverBody, /Parent directory is missing/);
  assert.match(created.json.error.serverBody, /redacted/); cases.push('http-parent-error-scrubbed');
  const input = join(root, 'input.json');
  await writeFile(input, JSON.stringify({ notebookId: 'owned', cellId: 'owned', runId: 'owned', expectedSourceHash: '123456789abc' }));
  const before = requests.length;
  const hash = await invoke('execute', ['--input-file', input]);
  assert.equal(hash.code, 7, hash.stdout); assert.equal(hash.json.error.code, 'invalid_source_hash');
  assert.equal(hash.json.error.outcome, 'not-submitted'); assert.equal(requests.length, before); cases.push('invalid-hash-zero-requests');
  mode = 'denied'; const denied = await invoke('check', ['--verbose']);
  assert.equal(denied.code, 3, denied.stdout); assert.equal(denied.json.error.layer, 'auth');
  assert.equal(denied.json.error.status, 401); cases.push('auth-rejection');
  mode = 'bad-json'; const invalid = await invoke('check');
  assert.equal(invalid.code, 2, invalid.stdout); assert.equal(invalid.json.error.layer, 'schema'); cases.push('invalid-json-response');
  const missing = await invoke('check', [], unconfigured, unconfigured);
  assert.equal(missing.code, 3); assert.equal(missing.json.error.code, 'credentials_missing'); cases.push('missing-credentials');
  await new Promise(resolve => server.close(resolve));
  const disconnected = await invoke('check');
  assert.equal(disconnected.code, 5, disconnected.stdout); assert.equal(disconnected.json.error.layer, 'tcp');
  assert.equal(disconnected.json.error.outcome, 'unknown'); cases.push('tcp-unavailable');
  const executionPosts = requests.filter(request => request.method === 'POST' && /kernels/.test(request.route));
  assert.deepEqual(executionPosts, []);
  console.log(JSON.stringify({ jupyterDiagnosticsFixture: { passed: true, cases, ownedHttpRequests: requests.length,
    executionPosts: executionPosts.length, configuredJupyterRequests: 0, externalModelInputs: 0, channelConnections: 0,
    productAcceptance: 'not_verified' } }));
} finally {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}

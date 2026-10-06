import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { JupyterConnections } from '../../packages/service/dist/jupyter/connections.js';

// Host-only inspection of the explicitly configured server. Does not start
// Jupyter, open a Notebook, claim a controller, or touch a kernel. Datalayer
// initialize/tools-list use read-only JSON-RPC POSTs, never tools/call.
const { values } = parseArgs({
  options: {
    'config-file': { type: 'string' },
    'connection-id': { type: 'string' },
    'env-file': { type: 'string' },
    output: { type: 'string' },
  },
});
for (const key of ['config-file', 'connection-id', 'output']) {
  if (!values[key]) throw new Error(`Explicit --${key} required`);
}
const output = path.resolve(values.output);
await fs.writeFile(output, '{"state":"starting"}\n', { flag: 'wx', mode: 0o600 });
const config = path.resolve(values['config-file']);
const environment = {
  ...process.env,
  ...(values['env-file']
    ? parseEnv(await fs.readFile(path.resolve(values['env-file']), 'utf8'))
    : {}),
};
const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = promisify(execFile);
const report = {
  state: 'failed',
  scope:
    'Configured-server host authentication and capability inspection; not Notebook product acceptance',
  startedAt: new Date().toISOString(),
  source: {
    head: (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim(),
    dirty: !!(await run('git', ['status', '--porcelain'], { cwd })).stdout.trim(),
  },
  requests: [],
};
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const response = await originalFetch(url, options);
  report.requests.push({
    path: new URL(url).pathname,
    method: options?.method ?? 'GET',
    status: response.status,
    ...(options?.method === 'POST' && new URL(url).pathname.endsWith('/mcp')
      ? { rpcMethod: JSON.parse(options.body).method }
      : {}),
  });
  return response;
};
try {
  const first = new JupyterConnections(config, () => environment);
  report.inspection = await first.inspect(values['connection-id']);
  const boundary = report.requests.length;
  const resumed = new JupyterConnections(config, () => environment);
  report.resumedInspection = await resumed.inspect(values['connection-id']);
  report.resumedWithoutLoginPost = !report.requests
    .slice(boundary)
    .some((x) => x.method === 'POST' && x.path.endsWith('/login'));
  const modelEnvironment = { ...environment };
  first.redactEnvironment(modelEnvironment);
  const definitions = JSON.parse(await fs.readFile(config, 'utf8')).connections;
  const references = definitions
    .flatMap((x) => [x.authorizationEnv, x.passwordEnv])
    .filter(Boolean);
  report.authenticationEnvironmentRemoved = references.every(
    (name) => modelEnvironment[name] === undefined
  );
  report.onlySafeConnectionRequests = report.requests.every(
    (x) =>
      x.method === 'GET' ||
      (x.method === 'POST' && x.path.endsWith('/login')) ||
      (x.method === 'POST' &&
        x.path.endsWith('/mcp') &&
        ['initialize', 'tools/list'].includes(x.rpcMethod))
  );
  if (
    !report.resumedWithoutLoginPost ||
    !report.authenticationEnvironmentRemoved ||
    !report.onlySafeConnectionRequests
  )
    throw new Error('Connection inspection invariant failed');
  report.state = 'passed';
} catch {
  report.failure = 'Configured connection could not be verified; host-private errors omitted';
} finally {
  globalThis.fetch = originalFetch;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(
    JSON.stringify({
      state: report.state,
      source: report.source,
      inspection: report.inspection,
      resumedWithoutLoginPost: report.resumedWithoutLoginPost,
      authenticationEnvironmentRemoved: report.authenticationEnvironmentRemoved,
    })
  );
}
if (report.state !== 'passed') process.exitCode = 1;

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { parseArgs, parseEnv, promisify } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import { createJupyterCookieJar } from '../../packages/core/dist/jupyter/http-connection.js';
import { JupyterConnections } from '../../packages/service/dist/jupyter/connections.js';
import { notebookSessionFactory } from '../../packages/service/dist/jupyter/agent-session.js';
import { JupyterProjectConfigStore } from '../../packages/service/dist/jupyter/project-config-store.js';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    output: { type: 'string' },
    'restart-ssh': { type: 'string' },
    'restart-container': { type: 'string' },
    'restart-image': { type: 'string' },
  },
});
if (!values['env-file'] || !values.output)
  throw new Error('Explicit environment file/output required');
const restart = ['restart-ssh', 'restart-container', 'restart-image'].map((name) => values[name]);
if (restart.some(Boolean) && !restart.every(Boolean))
  throw new Error('All three explicit restart arguments required');
if (
  restart.every(Boolean) &&
  (!/^[A-Za-z0-9_.@-]+$/.test(restart[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(restart[1]) ||
    !/^sha256:[a-f0-9]{64}$/.test(restart[2]))
)
  throw new Error('Invalid restart identity');
const directory = path.resolve(values.output);
fs.mkdirSync(directory, { mode: 0o700 });
const env = parseEnv(fs.readFileSync(values['env-file'], 'utf8'));
if (!env.JUPYTERLAB_HOST || !env.JUPYTERLAB_PASS)
  throw new Error('Configured credentials unavailable');
const client = new DatalayerJupyterClient({
  baseUrl: env.JUPYTERLAB_HOST,
  password: async () => env.JUPYTERLAB_PASS,
  allowInsecureHttp: true,
  timeoutMs: 12000,
});
const before = {
  kernels: await client.json('api/kernels'),
  sessions: await client.json('api/sessions'),
};
if (restart.every(Boolean) && (before.kernels.length || before.sessions.length))
  throw new Error('Server restart acceptance requires an otherwise idle deployment');
const report = {
  startedAt: new Date().toISOString(),
  scope:
    'Configured-server auth, actual HTTP timeout, lost-reply injection, native kernel restart and optional guarded Docker restart; no native UI/Feishu acceptance',
  checks: [],
  requests: [],
  ownedNotebooks: [],
  restartAuthorized: restart.every(Boolean),
};
const persist = () => {
  const text = JSON.stringify(report, null, 2);
  if (text.includes(env.JUPYTERLAB_PASS)) throw new Error('Credential reached evidence');
  fs.writeFileSync(path.join(directory, 'report.json'), text + '\n', { mode: 0o600 });
};
const check = (name, passed, evidence) => {
  report.checks.push({ name, passed, evidence });
  persist();
  console.log(JSON.stringify({ name, passed }));
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unpack = (result) =>
  typeof result?.outputs === 'string' ? JSON.parse(result.outputs) : (result?.outputs ?? []);
const stdout = (result) =>
  unpack(result)
    .filter((o) => o.output_type === 'stream' && o.name === 'stdout')
    .map((o) => o.text)
    .join('');
async function peek(handle) {
  const response = await client.response(
    `api/kernels/${handle.kernelId}/requests/${handle.requestId}`
  );
  if (![200, 202, 404, 410, 500].includes(response.status)) {
    await response.body?.cancel();
    return { httpStatus: response.status };
  }
  return { httpStatus: response.status, result: JSON.parse(await response.text()) };
}
async function until(handle, marker) {
  const deadline = Date.now() + 15000;
  do {
    const result = await peek(handle);
    if (marker ? stdout(result.result).includes(marker) : result.httpStatus !== 202) return result;
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error('Original request did not reach the bounded observation');
}
const project = path.join(directory, 'project');
fs.mkdirSync(project, { mode: 0o700 });
const config = path.join(directory, 'connections.json');
const connectionId = 'fault-probe',
  namespace = 'configured-datalayer-fault';
const definition = {
  id: connectionId,
  backend: 'datalayer',
  baseUrl: env.JUPYTERLAB_HOST,
  passwordEnv: 'JUPYTERLAB_PASS',
  allowInsecureHttp: true,
};
fs.writeFileSync(config, JSON.stringify({ version: 1, connections: [definition] }), {
  mode: 0o600,
});
const connections = new JupyterConnections(config, () => env);
const api = await connections.useDatalayer(connectionId, namespace, async (value) => value);
const response = api.response.bind(api);
api.response = async (route, method = 'GET', body) => {
  const result = await response(route, method, body);
  report.requests.push({ route, method, status: result.status });
  return result;
};
const factory = notebookSessionFactory(connections);
const created = [];
let owner, peer, nativeSession;
let context = {
  workingDir: project,
  conversationKey: 'fault-original',
  currentWorkingDir: () => project,
};
const create = () => {
  const session = factory(context);
  created.push(session);
  return session;
};
const call = (name, input, session = owner) =>
  session.tools
    .find((tool) => tool.name === name)
    .execute(input, { signal: new AbortController().signal });
let notebookId;
const args = async (runId) => ({
  notebookId,
  cellId: 'fault-code',
  runId,
  expectedSourceHash: (await call('notebook_read_cell', { notebookId, cellId: 'fault-code' }))
    .sourceHash,
});
const posts = () =>
  report.requests.filter((r) => r.method === 'POST' && r.route.endsWith('/execute')).length;
const edit = async (source) => {
  const cell = await call('notebook_read_cell', { notebookId, cellId: 'fault-code' });
  const edited = await call('notebook_edit_cell', {
    notebookId,
    cellId: 'fault-code',
    expectedSourceHash: cell.sourceHash,
    source,
  });
  if (edited.state !== 'edited') throw new Error('Owned fault source was not edited');
};
async function observe(runId) {
  const deadline = Date.now() + 15000;
  do {
    const result = await call('notebook_status', { notebookId, runId });
    if (!['accepted', 'running'].includes(result.state)) return result;
    await wait(100);
  } while (Date.now() < deadline);
  throw new Error('Host original status timed out');
}
const file = `disclaude-datalayer-fault-${randomUUID().slice(0, 8)}.ipynb`;
try {
  const absent = await client.response('api/contents/' + file);
  if (absent.status !== 404) throw new Error('Scratch ownership unavailable');
  await absent.body?.cancel();
  await client.json('api/contents/' + file, 'PUT', {
    type: 'notebook',
    format: 'json',
    content: {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          name: 'conda-base-py',
          display_name: 'Python (conda base)',
          language: 'python',
        },
      },
      cells: [
        {
          id: 'fault-code',
          cell_type: 'code',
          source: "fault_memory=11\nprint('AUTH_ORIGINAL_RESULT',fault_memory)",
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        {
          id: 'fault-note',
          cell_type: 'markdown',
          source: 'Preserve this human note across failures.',
          metadata: { unknown: { preserve: true } },
        },
      ],
    },
  });
  report.ownedNotebooks.push(file);
  nativeSession = await client.json('api/sessions', 'POST', {
    path: file,
    name: file,
    type: 'notebook',
    kernel: { name: 'conda-base-py' },
  });
  const kernelId = nativeSession.kernel.id;
  const incarnation = await client.kernelInfo(kernelId);
  const linked = new JupyterProjectConfigStore(project).linkNotebook({
    connectionId,
    serverNamespace: namespace,
    contentPath: file,
  });
  if (!linked.ok) throw new Error('Project link unavailable');
  owner = create();
  [{ notebookId }] = (await call('notebook_list', {})).notebooks;
  const reference = new JupyterProjectConfigStore(project).listNotebookReferences().data[0];
  peer = await client.openDocument(file, reference.documentId);
  const accepted = await call('notebook_execute', await args('auth-original'));
  const handle = { kernelId, requestId: accepted.requestId };
  const original = await until(handle);

  const badConfig = path.join(directory, 'invalid-authorization.json');
  const { passwordEnv, ...tokenDefinition } = definition;
  fs.writeFileSync(
    badConfig,
    JSON.stringify({
      version: 1,
      connections: [{ ...tokenDefinition, authorizationEnv: 'FAULT_INVALID_AUTH' }],
    }),
    { mode: 0o600 }
  );
  const badConnections = new JupyterConnections(badConfig, () => ({
    FAULT_INVALID_AUTH: 'token intentionally-invalid-acceptance-credential',
  }));
  const badClient = await badConnections.useDatalayer(
    connectionId,
    namespace,
    async (value) => value
  );
  const badResponse = badClient.response.bind(badClient),
    badRequests = [];
  badClient.response = async (route, method = 'GET', body) => {
    const result = await badResponse(route, method, body);
    badRequests.push({ route, method, status: result.status });
    return result;
  };
  const badOwner = notebookSessionFactory(badConnections)(context);
  created.push(badOwner);
  const denied = await call('notebook_status', { notebookId, runId: 'auth-original' }, badOwner);
  const restored = await observe('auth-original');
  check(
    'Invalid native authentication preserves unknown original identity and recovers without replay',
    denied.state === 'unknown' &&
      denied.requestId === accepted.requestId &&
      badRequests.some((r) => [401, 403].includes(r.status)) &&
      badRequests.every((r) => r.method === 'GET') &&
      restored.state === 'completed' &&
      restored.requestId === accepted.requestId &&
      posts() === 1,
    { denied, badRequests, restored, original }
  );

  const jars = fs
    .readdirSync(path.join(directory, 'sessions'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(directory, 'sessions', name))));
  const savedJar = jars.find((jar) => jar.cookies?.some((cookie) => cookie.key !== '_xsrf'));
  if (!savedJar) throw new Error('Owned authenticated cookie state unavailable for timeout case');
  const timeoutClient = new DatalayerJupyterClient({
    baseUrl: env.JUPYTERLAB_HOST,
    password: async () => env.JUPYTERLAB_PASS,
    allowInsecureHttp: true,
    cookieJar: await createJupyterCookieJar(savedJar),
    timeoutMs: 1,
  });
  const timed = await timeoutClient.observe(handle);
  const afterTimeout = await peek(handle);
  check(
    'Actual one-millisecond configured HTTP timeout does not disprove execution or replay it',
    timed.state === 'unknown' &&
      afterTimeout.result?.status === 'ok' &&
      stdout(afterTimeout.result).includes('AUTH_ORIGINAL_RESULT 11') &&
      posts() === 1,
    { timeoutMs: 1, timed, afterTimeout, executePosts: posts() }
  );

  await edit(
    "reply_counter=globals().get('reply_counter',0)+1\nprint('LOST_REPLY_COUNTER',reply_counter)"
  );
  const lostArgs = await args('lost-reply-original');
  const actualResponse = api.response.bind(api);
  let acceptedLocation;
  api.response = async (route, method = 'GET', body) => {
    const result = await actualResponse(route, method, body);
    if (
      method === 'POST' &&
      route.endsWith('/execute') &&
      result.status === 202 &&
      !acceptedLocation
    ) {
      acceptedLocation = result.headers.get('location');
      await result.body?.cancel();
      throw new Error('Injected loss after the remote server accepted the execution');
    }
    return result;
  };
  const lost = await call('notebook_execute', lostArgs);
  api.response = actualResponse;
  const requestId = acceptedLocation?.match(/\/requests\/([A-Za-z0-9_-]+)$/)?.[1];
  if (!requestId) throw new Error('Auditor did not capture the actual remote acceptance');
  const executed = await until({ kernelId, requestId });
  const repeated = await call('notebook_execute', lostArgs);
  check(
    'Lost accepted reply remains unknown without a Service handle and is never replayed',
    lost.state === 'unknown' &&
      lost.requestId === undefined &&
      repeated.state === 'unknown' &&
      repeated.requestId === undefined &&
      posts() === 2 &&
      stdout(executed.result).includes('LOST_REPLY_COUNTER 1'),
    {
      faultInjection:
        'Host drops the genuine 202 reply; auditor-only identity is not adopted by Service',
      lost,
      repeated,
      executed,
      executePosts: posts(),
    }
  );

  await client.json('api/kernels/' + kernelId + '/restart', 'POST', {});
  const nextIncarnation = await client.kernelInfo(kernelId);
  let memoryError;
  try {
    await call('notebook_execute', await args('after-native-restart'));
  } catch (error) {
    memoryError = error.message;
  }
  check(
    'Native kernel restart refuses silent continuation of original kernel memory',
    nextIncarnation.incarnation !== incarnation.incarnation &&
      memoryError?.includes('memory was lost') &&
      posts() === 2,
    { originalIncarnation: incarnation, nextIncarnation, memoryError, executePosts: posts() }
  );

  if (restart.every(Boolean)) {
    owner.dispose();
    context = { ...context, conversationKey: 'jupyter-restart-original' };
    owner = create();
    await edit(
      "import time\njupyter_restart_memory=37\nprint('JUPYTER_RESTART_BEGIN',flush=True)\ntime.sleep(45)\nprint('JUPYTER_RESTART_LATE')"
    );
    const restartArgs = await args('before-jupyter-restart');
    const pending = await call('notebook_execute', restartArgs);
    const originalHandle = { kernelId, requestId: pending.requestId };
    await until(originalHandle, 'JUPYTER_RESTART_BEGIN');
    await wait(1300);
    const policyBefore = await client.executionPolicy();
    owner.dispose();
    peer.close();
    peer = undefined;
    const program = `import json,subprocess,sys,time
cfg=json.loads(sys.argv[1])
c=json.loads(subprocess.check_output(['docker','inspect',cfg['container']]))[0]
if c['Image']!=cfg['image']:raise RuntimeError('Candidate image changed; restart refused')
probe = """import json,os,urllib.request
def get(route):
 r=urllib.request.Request('http://127.0.0.1:8888/'+route,headers={'Authorization':'token '+os.environ['JUPYTER_TOKEN']})
 with urllib.request.urlopen(r,timeout=5) as response:return json.load(response)
print(json.dumps({'kernels':[k['id'] for k in get('api/kernels')],'sessions':[s['id'] for s in get('api/sessions')]}))
"""
observed=json.loads(subprocess.check_output(['docker','exec',cfg['container'],'python','-c',probe]))
if observed!={'kernels':[cfg['kernelId']],'sessions':[cfg['sessionId']]}:raise RuntimeError('Unowned live workloads present; restart refused')
started=time.monotonic()
subprocess.run(['docker','restart','--time','15',cfg['container']],check=True,capture_output=True,timeout=45)
deadline=time.monotonic()+75
while time.monotonic()<deadline:
 state=json.loads(subprocess.check_output(['docker','inspect',cfg['container']]))[0]
 if state['State']['Running'] and state['State'].get('Health',{}).get('Status')=='healthy':break
 time.sleep(1)
else:raise RuntimeError('Restarted candidate did not become healthy')
print(json.dumps({'containerId':state['Id'],'imageId':state['Image'],'sameContainer':state['Id']==c['Id'],'elapsedSeconds':round(time.monotonic()-started,3),'healthy':True,'beforeOwnedResources':observed}))
`;
    const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command =
      'python3 -c ' +
      quote(program) +
      ' ' +
      quote(
        JSON.stringify({
          container: restart[1],
          image: restart[2],
          kernelId,
          sessionId: nativeSession.id,
        })
      );
    const switched = await promisify(execFile)('ssh', [restart[0], command], {
      timeout: 150000,
      maxBuffer: 128 * 1024,
    });
    report.restart = JSON.parse(switched.stdout.trim().split('\n').at(-1));
    persist();
    const policyAfter = await client.executionPolicy();
    owner = create();
    const missing = await call('notebook_status', { notebookId, runId: restartArgs.runId });
    const repeatedAfterRestart = await call('notebook_execute', restartArgs);
    let newRunError;
    try {
      await call('notebook_execute', await args('new-run-after-jupyter-loss'));
    } catch (error) {
      newRunError = error.message;
    }
    const identityPath = await client.documentPath(reference.documentId);
    const disk = await client.json('api/contents/' + file);
    check(
      'Jupyter restart preserves native document identity but leaves lost request/memory unknown without replay',
      report.restart.sameContainer &&
        policyBefore.serverInstanceId !== policyAfter.serverInstanceId &&
        missing.state === 'unknown' &&
        missing.requestId === pending.requestId &&
        repeatedAfterRestart.state === 'unknown' &&
        newRunError?.includes('kernel is missing') &&
        identityPath === file &&
        posts() === 3 &&
        disk.content.cells.find((cell) => cell.id === 'fault-note').source ===
          'Preserve this human note across failures.' &&
        !stdout(disk.content.cells.find((cell) => cell.id === 'fault-code')).includes(
          'JUPYTER_RESTART_LATE'
        ),
      {
        policyBefore,
        policyAfter,
        missing,
        repeatedAfterRestart,
        newRunError,
        identityPath,
        executePosts: posts(),
        note: disk.content.cells.find((cell) => cell.id === 'fault-note'),
        restart: report.restart,
      }
    );
  } else {
    report.jupyterRestart = {
      state: 'not_verified',
      reason: 'No explicit remote restart identity supplied',
    };
    persist();
  }
} catch (error) {
  report.operationError = error.message.replaceAll(env.JUPYTERLAB_PASS, '[REDACTED]');
  persist();
} finally {
  peer?.close();
  for (const session of created) session.dispose();
  if (nativeSession) {
    const remaining = await client.json('api/sessions');
    if (remaining.some((session) => session.id === nativeSession.id)) {
      try {
        await client.json('api/sessions/' + nativeSession.id, 'DELETE');
      } catch (error) {
        report.cleanupError = error.message;
      }
    }
  }
}
const after = {
  kernels: await client.json('api/kernels'),
  sessions: await client.json('api/sessions'),
};
report.originalResourcesPreserved =
  before.kernels.every((k) => after.kernels.some((item) => item.id === k.id)) &&
  before.sessions.every((s) => after.sessions.some((item) => item.id === s.id));
report.resourceCounts = {
  kernels: [before.kernels.length, after.kernels.length],
  sessions: [before.sessions.length, after.sessions.length],
};
report.completed = !report.operationError && !report.cleanupError;
report.finishedAt = new Date().toISOString();
persist();
console.log(
  JSON.stringify({
    output: directory,
    completed: report.completed,
    passed: report.checks.filter((c) => c.passed).length,
    checks: report.checks.length,
    resourceCounts: report.resourceCounts,
  })
);
if (!report.completed || !report.originalResourcesPreserved || report.checks.some((c) => !c.passed))
  process.exitCode = 1;

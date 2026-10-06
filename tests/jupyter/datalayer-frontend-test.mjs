import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseArgs } from 'node:util';

// Run the installed/patched federation modules in an isolated test realm.
// The Jupyter services below are fixtures; no browser or HTTP request is opened.
const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
if (!values.bundle) throw new Error('Explicit --bundle required');
const self = {};
const context = vm.createContext({
  self,
  console,
  WeakSet,
  setTimeout,
  clearTimeout,
  window: { setTimeout, clearTimeout },
});
new vm.Script(fs.readFileSync(values.bundle, 'utf8'), { filename: values.bundle }).runInContext(
  context
);
const chunks = self.rspackChunk_datalayer_jupyter_server_nbmodel;
assert.equal(chunks.length, 1);
const factories = chunks[0][1];
const cached = new Map();
let replies = [];
let reconciliations = 0;
class PromiseDelegate {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
class ResponseError extends Error {}
const modules = {
  'webpack/sharing/consume/default/@jupyterlab/apputils': {},
  'webpack/sharing/consume/default/@jupyterlab/coreutils': {
    URLExt: { join: (...parts) => parts.join('/').replace(/(?<!:)\/+/g, '/') },
  },
  'webpack/sharing/consume/default/@jupyterlab/services': {
    ServerConnection: {
      ResponseError,
      makeRequest: async () => {
        assert.ok(replies.length);
        return replies.shift();
      },
    },
  },
  'webpack/sharing/consume/default/@jupyterlab/translation': { nullTranslator: {} },
  'webpack/sharing/consume/default/@lumino/coreutils': { PromiseDelegate },
  'webpack/sharing/consume/default/@lumino/widgets': {},
  'webpack/sharing/consume/default/@jupyterlab/outputarea': {},
  './lib/outputReconciliation.js': {
    normalizeServerOutputs: (value) => (typeof value === 'string' ? JSON.parse(value) : value),
    reconcileOutputSnapshot: (cell, outputs) => {
      reconciliations++;
      cell.model.sharedModel.outputs = outputs;
    },
  },
  './lib/settings.js': { isOutputRecoveryEnabled: () => true },
  './lib/submissionQueue.js': {},
};
function requireModule(name) {
  if (modules[name]) return modules[name];
  if (cached.has(name)) return cached.get(name);
  assert.ok(factories[name], `Unknown test module: ${name}`);
  const exports = {};
  cached.set(name, exports);
  factories[name]({}, exports, requireModule);
  return exports;
}
requireModule.r = () => {};
requireModule.d = (exports, definitions) => {
  for (const [name, get] of Object.entries(definitions))
    Object.defineProperty(exports, name, { get });
};
requireModule.n = (value) => () => value;
const metadata = requireModule('./lib/executionMetadata.js');
const executor = requireModule('./lib/executor.js');
const request = requireModule('./lib/requestServer.js');
function cell(source = 'original', id = 'cell') {
  const fields = new Map();
  const sharedModel = {
    getSource: () => source,
    getId: () => id,
    getOutputs() {
      return this.outputs;
    },
    outputs: [{ output_type: 'stream', text: 'current' }],
    execution_count: 7,
  };
  return {
    isDisposed: false,
    fields,
    model: {
      sharedModel,
      getMetadata: (key) => fields.get(key),
      setMetadata: (key, value) => fields.set(key, value),
      deleteMetadata: (key) => fields.delete(key),
    },
  };
}
const original = {
  source: 'original',
  cell_id: 'cell',
  request_id: 'request',
  kernel_id: 'kernel',
  kernel_incarnation: 'instance',
  output_version: 3,
  request_status: 'complete',
  status: 'ok',
  outputs: '[{"output_type":"stream","text":"original"}]',
  execution_count: 1,
};
const cases = [];
function check(name, callback) {
  callback();
  cases.push({ name, passed: true });
}
check('matching source/cell permits a snapshot', () =>
  assert.equal(metadata.canApplyServerSnapshot(cell(), original), true)
);
check('edited source refuses original outputs', () =>
  assert.equal(metadata.canApplyServerSnapshot(cell('human edit'), original), false)
);
check('another cell refuses original outputs', () =>
  assert.equal(metadata.canApplyServerSnapshot(cell('original', 'another'), original), false)
);
check('disposed cell refuses outputs', () =>
  assert.equal(metadata.canApplyServerSnapshot({ ...cell(), isDisposed: true }, original), false)
);
check('missing source is unverified', () =>
  assert.equal(metadata.canApplyServerSnapshot(cell(), { ...original, source: undefined }), false)
);
check('historical result refuses writeback', () =>
  assert.equal(
    metadata.canApplyServerSnapshot(cell(), { ...original, output_attachment: 'historical' }),
    false
  )
);
check('bounded preview does not erase full outputs', () =>
  assert.equal(
    metadata.canApplyServerSnapshot(cell(), { ...original, outputs_truncated: true }),
    false
  )
);
check('a new running request fences old result', () => {
  const c = cell();
  c.fields.set('jupyter_server_nbmodel', {
    requestId: 'new',
    kernelId: 'kernel',
    requestUrl: '/new',
  });
  assert.equal(metadata.canApplyServerSnapshot(c, original), false);
});
check('a new queued request can replace finished provenance', () => {
  const c = cell();
  c.fields.set('jupyter_server_nbmodel_provenance', { requestId: 'previous' });
  assert.equal(metadata.canApplyServerSnapshot(c, { ...original, request_status: 'queued' }), true);
});
check('kernel incarnation mismatch refuses a snapshot', () => {
  const c = cell();
  c.fields.set('jupyter_server_nbmodel_provenance', {
    requestId: 'request',
    kernelIncarnation: 'new-instance',
  });
  assert.equal(metadata.canApplyServerSnapshot(c, original), false);
});
check('newer RTC display version fences older HTTP snapshot', () => {
  const c = cell();
  c.fields.set('jupyter_server_nbmodel_provenance', { requestId: 'request', outputVersion: 4 });
  assert.equal(metadata.canApplyServerSnapshot(c, original), false);
});
check('another request display update fences original snapshot', () => {
  const c = cell();
  c.fields.set('jupyter_server_nbmodel_provenance', {
    requestId: 'request',
    displayUpdatedByRequestId: 'next',
  });
  assert.equal(metadata.canApplyServerSnapshot(c, original), false);
});
function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      Location: '/api/kernels/kernel/requests/request',
      'Content-Type': 'application/json',
    },
  });
}
{
  const c = cell('human edit');
  c.fields.set('jupyter_server_nbmodel', {
    requestId: 'request',
    kernelId: 'kernel',
    requestUrl: '/original',
  });
  replies = [response(original)];
  const before = reconciliations;
  assert.equal(
    await executor.resumeCellServerExecution(c, '/original', { baseUrl: 'https://configured/' }),
    false
  );
  assert.equal(reconciliations, before);
  assert.equal(c.model.sharedModel.execution_count, 7);
  assert.equal(c.model.sharedModel.executionState, 'idle');
  cases.push({
    name: 'actual resume leaves edited cell/output intact and ends original spinner',
    passed: true,
  });
}
{
  const c = cell();
  c.fields.set('jupyter_server_nbmodel', {
    requestId: 'new',
    kernelId: 'kernel',
    requestUrl: '/new',
  });
  replies = [response(original)];
  const before = reconciliations;
  assert.equal(
    await executor.resumeCellServerExecution(c, '/original', { baseUrl: 'https://configured/' }),
    false
  );
  assert.equal(reconciliations, before);
  assert.equal(c.fields.get('jupyter_server_nbmodel').requestId, 'new');
  assert.equal(c.model.sharedModel.executionState, 'running');
  cases.push({ name: 'actual resume does not clear a newer execution marker', passed: true });
}
{
  const c = cell();
  replies = [response(original)];
  assert.equal(
    await executor.resumeCellServerExecution(c, '/original', { baseUrl: 'https://configured/' }),
    true
  );
  assert.equal(c.model.sharedModel.execution_count, 1);
  assert.equal(c.model.sharedModel.outputs[0].text, 'original');
  cases.push({ name: 'matching actual resume still applies outputs/count', passed: true });
}
{
  const c = cell('human edit');
  const before = reconciliations;
  replies = [
    response({ ...original, pending: true, request_status: 'queued' }, 202),
    response(original),
  ];
  let accepted = 0;
  const result = await request.requestServer(
    c,
    'https://configured/api/kernels/kernel/execute',
    { method: 'POST' },
    { baseUrl: 'https://configured/' },
    undefined,
    1,
    () => accepted++,
    true
  );
  assert.equal(result.status, 200);
  assert.equal(accepted, 1);
  assert.equal(reconciliations, before);
  assert.equal(c.fields.has('jupyter_server_nbmodel'), false);
  cases.push({
    name: 'actual pending recovery keeps polling without writing stale outputs/metadata',
    passed: true,
  });
}
console.log(
  JSON.stringify(
    {
      scope: 'Isolated bundled frontend modules; not native browser acceptance',
      passed: cases.length,
      cases,
    },
    null,
    2
  )
);

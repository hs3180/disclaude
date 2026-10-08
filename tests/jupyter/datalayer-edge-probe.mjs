import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs, parseEnv } from 'node:util';
import { createCLIProbe, probeSource } from './cli-probe-client.mjs';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    output: { type: 'string' },
    cases: { type: 'string' },
  },
});
if (!values['env-file'] || !values.output)
  throw new Error('Explicit environment file and new output directory required');
const selected = values.cases ? new Set(values.cases.split(',')) : undefined;
const knownCases = new Set([
  'queued-cancel',
  'finished-cancel',
  'edit-running',
  'pending-host-recovery',
  'kernel-incarnation',
  'output-features',
  'document-identity',
  'terminal-host-recovery',
  'move-delete-running',
  'display-many-positions',
  'clear-immediate',
  'large-output-stdin',
  'completion-cancel-race',
  'cli-stop-continuation',
  'export-revision-race',
]);
if (selected && [...selected].some((name) => !knownCases.has(name)))
  throw new Error('Unknown edge case selection');
const root = path.resolve(values.output);
fs.mkdirSync(root, { mode: 0o700 });
const env = parseEnv(fs.readFileSync(values['env-file'], 'utf8'));
if (!env.JUPYTERLAB_HOST || !env.JUPYTERLAB_PASS)
  throw new Error('Configured remote Jupyter credentials unavailable');
const client = new DatalayerJupyterClient({
  baseUrl: env.JUPYTERLAB_HOST,
  password: async () => env.JUPYTERLAB_PASS,
  allowInsecureHttp: true,
  timeoutMs: 12000,
});
const originalKernels = await client.json('api/kernels'),
  originalSessions = await client.json('api/sessions');
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Configured remote Datalayer edge cases; only isolated owned notebooks/kernels; no server reconfiguration or restart',
  checks: [],
  ownedNotebooks: [],
  selectedCases: selected ? [...selected] : [...knownCases],
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const persist = () => {
  const text = JSON.stringify(report, null, 2);
  if (text.includes(env.JUPYTERLAB_PASS)) throw new Error('Credential reached evidence');
  fs.writeFileSync(path.join(root, 'report.json'), text + '\n', { mode: 0o600 });
};
const check = (name, passed, evidence) => {
  report.checks.push({ name, passed, evidence });
  persist();
  console.log(JSON.stringify({ name, passed }));
};
const outputs = (result) =>
  typeof result?.outputs === 'string' ? JSON.parse(result.outputs) : (result?.outputs ?? []);
const stdout = (result) =>
  outputs(result)
    .filter((o) => o.output_type === 'stream' && o.name === 'stdout')
    .map((o) => o.text)
    .join('');
async function peek(handle) {
  const response = await client.response(
    `api/kernels/${handle.kernelId}/requests/${handle.requestId}`
  );
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {}
  return { httpStatus: response.status, result };
}
async function terminal(handle, seconds = 8) {
  const deadline = Date.now() + seconds * 1000;
  let item;
  do {
    item = await peek(handle);
    if (item.httpStatus !== 202) return item;
    await wait(120);
  } while (Date.now() < deadline);
  return item;
}
async function active(handle, marker) {
  const deadline = Date.now() + 8000;
  do {
    const item = await peek(handle);
    if (item.httpStatus !== 202) throw new Error('Run became terminal before active check');
    if (stdout(item.result).includes(marker)) return item;
    await wait(120);
  } while (Date.now() < deadline);
  throw new Error('Owned execution did not publish its start marker');
}
async function submit(context, cellId, code) {
  const result = await client.submitCell(context.kernelId, context.doc.documentId, cellId, code);
  if (result.state !== 'accepted') throw new Error('Owned execution was not accepted');
  return result.handle;
}
const markdown = {
  id: 'edge-note',
  cell_type: 'markdown',
  metadata: { unrecognized: { preserve: 'metadata-marker' } },
  source: 'Human note: keep my conclusion.',
  attachments: {
    'marker.svg': {
      'image/svg+xml': Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><text>attachment-marker</text></svg>'
      ).toString('base64'),
    },
  },
};

async function withCLI(c, name, work) {
  const project = path.join(root, 'project-' + name);
  fs.mkdirSync(project, { mode: 0o700 });
  const probe = await createCLIProbe({
    envFile: values['env-file'],
    project,
    directory: project,
    observe: true,
  });
  try {
    const linked = await probe.command('link', undefined, ['--path', c.file]);
    const notebookId = linked.notebookId;
    const call = probe.call;
    const args = async (cellId, runId) => ({
      notebookId,
      cellId,
      runId,
      expectedSourceHash: (await call('notebook_read_cell', { notebookId, cellId })).sourceHash,
    });
    const status = async (runId) => {
      const deadline = Date.now() + 15000;
      do {
        const result = await call('notebook_status', { notebookId, runId });
        if (!['accepted', 'running'].includes(result.state)) return result;
        await wait(100);
      } while (Date.now() < deadline);
      throw new Error('Original request did not reach an observable terminal state');
    };
    await work({ project, probe, requests: probe.requests, call, notebookId, args, status });
  } finally {
    await probe.close();
    report.commands ??= [];
    report.commands.push(...probe.commands);
    persist();
  }
}

async function freshStatus(f, runId, offline = false) {
  const before = f.requests.length;
  if (offline) f.probe.traffic.fault = { kind: 'offline' };
  try {
    const result = await f.call('notebook_status', { notebookId: f.notebookId, runId });
    const requests = f.requests.slice(before);
    return {
      kind: 'fresh-cli-status',
      pid: f.probe.commands.at(-1).pid,
      result,
      executePosts: requests.filter((r) => r.method === 'POST' && r.route.endsWith('/execute'))
        .length,
      requests,
    };
  } finally {
    f.probe.traffic.fault = undefined;
  }
}

async function watchOutputs(c, work) {
  const { default: WebSocket } = await import('ws');
  const options = await client.socket(
    `api/kernels/${c.kernelId}/channels?session_id=${randomUUID()}`
  );
  const socket = new WebSocket(options.url, {
    headers: options.headers,
    followRedirects: false,
    handshakeTimeout: 12000,
    maxPayload: 1024 * 1024,
  });
  const messages = [];
  socket.on('error', () => {});
  socket.on('message', (data) => {
    try {
      const m = JSON.parse(data.toString());
      if (
        m.channel === 'iopub' &&
        ['display_data', 'update_display_data', 'clear_output'].includes(m.header?.msg_type)
      )
        messages.push({
          type: m.header.msg_type,
          content: m.content,
          parentMessageId: m.parent_header?.msg_id,
        });
    } catch {}
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    await wait(150);
    await work(messages);
  } finally {
    socket.close();
  }
}
async function isolated(name, sources, work) {
  if (selected && !selected.has(name)) return;
  const file = `disclaude-datalayer-edge-${name}-${randomUUID().slice(0, 8)}.ipynb`;
  let session, doc;
  try {
    const absent = await client.response('api/contents/' + file);
    if (absent.status !== 404) throw new Error('Scratch ownership unavailable');
    await absent.body?.cancel();
    const cells = sources.map((source, index) => ({
      id: 'edge-' + index,
      cell_type: 'code',
      metadata: {},
      source,
      execution_count: null,
      outputs: [],
    }));
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
        cells: [...cells, markdown],
      },
    });
    report.ownedNotebooks.push(file);
    persist();
    session = await client.json('api/sessions', 'POST', {
      path: file,
      name: file,
      type: 'notebook',
      kernel: { name: 'conda-base-py' },
    });
    const kernelId = session.kernel.id;
    const incarnation = await client.kernelInfo(kernelId);
    doc = await client.openDocument(file);
    await work({ file, session, kernelId, incarnation, doc, sources });
  } catch (error) {
    report.operationErrors ??= [];
    report.operationErrors.push(name);
    check(name + ' probe completed', false, {
      error: error.message.replaceAll(env.JUPYTERLAB_PASS, '[REDACTED]'),
    });
  } finally {
    doc?.close();
    if (session) {
      try {
        await client.json('api/sessions/' + session.id, 'DELETE');
      } catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push({ sessionId: session.id, error: error.message });
        persist();
      }
    }
  }
}

await isolated(
  'queued-cancel',
  [
    "import time\nprint('ACTIVE_A_BEGIN',flush=True)\ntime.sleep(20)\nprint('ACTIVE_A_FINISHED')",
    "print('QUEUED_B_EXECUTED')",
  ],
  async (c) => {
    const a = await submit(c, 'edge-0', c.sources[0]);
    await active(a, 'ACTIVE_A_BEGIN');
    const b = await submit(c, 'edge-1', c.sources[1]);
    const cancel = await client.stopRequest(b);
    await wait(300);
    const aAfter = await peek(a),
      bAfter = await peek(b);
    check(
      'Cancelling queued B leaves running A uninterrupted',
      cancel === 'requested' && aAfter.httpStatus === 202,
      { cancel, a: aAfter, b: bAfter }
    );
    if (aAfter.httpStatus === 202) {
      await client.stopRequest(a);
      await terminal(a);
    }
    const bFinal = bAfter.httpStatus === 202 ? await terminal(b) : bAfter;
    check(
      'Cancelled queued B does not execute after A ends',
      cancel === 'requested' &&
        bFinal.httpStatus !== 202 &&
        !stdout(bFinal.result).includes('QUEUED_B_EXECUTED'),
      { cancel, b: bFinal }
    );
  }
);

await isolated(
  'finished-cancel',
  [
    "print('FINISHED_A')",
    "import time\nprint('ACTIVE_B_BEGIN',flush=True)\ntime.sleep(20)\nprint('ACTIVE_B_FINISHED')",
  ],
  async (c) => {
    const a = await submit(c, 'edge-0', c.sources[0]);
    const deadline = Date.now() + 8000;
    let finished = false;
    while (Date.now() < deadline) {
      await c.doc.flush();
      const state = await client.json('api/kernels/' + c.kernelId);
      if (
        state.execution_state === 'idle' &&
        stdout(c.doc.snapshot().cells[0]).includes('FINISHED_A')
      ) {
        finished = true;
        break;
      }
      await wait(120);
    }
    if (!finished)
      throw new Error('Completed A could not be confirmed without consuming its result');
    const b = await submit(c, 'edge-1', c.sources[1]);
    await active(b, 'ACTIVE_B_BEGIN');
    const cancel = await client.stopRequest(a);
    await wait(300);
    const bAfter = await peek(b);
    check(
      'Cancelling finished unread A leaves new running B uninterrupted',
      bAfter.httpStatus === 202,
      { cancel, b: bAfter, a: await peek(a) }
    );
    if (bAfter.httpStatus === 202) {
      await client.stopRequest(b);
      await terminal(b);
    }
  }
);

await isolated(
  'edit-running',
  ["import time\nprint('OLD_SOURCE_BEGIN',flush=True)\ntime.sleep(2)\nprint('OLD_SOURCE_RESULT')"],
  async (c) => {
    const handle = await submit(c, 'edge-0', c.sources[0]);
    await active(handle, 'OLD_SOURCE_BEGIN');
    const replacement = "print('NEW_SOURCE_RESULT')";
    c.doc.notebook.getCell(0).source = replacement;
    await c.doc.flush();
    const old = await terminal(handle);
    await wait(200);
    await c.doc.flush();
    const cell = c.doc.snapshot().cells[0];
    check(
      'Original execution remains identifiable after source edit',
      old.result?.status === 'ok' && stdout(old.result).includes('OLD_SOURCE_RESULT'),
      old
    );
    check(
      'Old output is not attached as current result of edited code',
      cell.source === replacement && !stdout(cell).includes('OLD_SOURCE_RESULT'),
      {
        currentSource: cell.source,
        executionCount: cell.execution_count,
        outputs: cell.outputs,
        metadata: cell.metadata,
        oldRequest: handle,
      }
    );
    const note = c.doc.snapshot().cells.find((x) => x.id === 'edge-note');
    check(
      'Runtime/source edits preserve unrelated metadata and attachment',
      JSON.stringify(note.metadata) === JSON.stringify(markdown.metadata) &&
        JSON.stringify(note.attachments) === JSON.stringify(markdown.attachments),
      { metadata: note.metadata, attachments: note.attachments }
    );
  }
);

await isolated(
  'pending-host-recovery',
  [
    "import time\nhost_pending_value = 43\nprint('HOST_PENDING_BEGIN',flush=True)\ntime.sleep(6)\nprint('HOST_PENDING_RESULT',host_pending_value)",
  ],
  async (c) => {
    await withCLI(c, 'pending-host-recovery', async (f) => {
      const { notebookId, call, requests } = f;
      const originalArgs = await f.args('edge-0', 'edge-pending-original');
      const accepted = await call('notebook_execute', originalArgs);
      if (accepted.state !== 'accepted')
        throw new Error('CLI did not accept the owned pending run');
      await active({ kernelId: c.kernelId, requestId: accepted.requestId }, 'HOST_PENDING_BEGIN');
      const observedStates = [],
        pids = [];
      let recovered;
      const deadline = Date.now() + 15000;
      do {
        const fresh = await freshStatus(f, originalArgs.runId);
        recovered = fresh.result;
        observedStates.push(recovered.state);
        pids.push(fresh.pid);
        if (!['accepted', 'running'].includes(recovered.state)) break;
        await wait(120);
      } while (Date.now() < deadline);
      const executePosts = requests.filter(
        (r) => r.method === 'POST' && r.route.endsWith('/execute')
      ).length;
      const currentIncarnation = await client.kernelInfo(c.kernelId);
      check(
        'Independent CLI processes recover the pending original request without replay',
        recovered.state === 'completed' &&
          recovered.requestId === accepted.requestId &&
          JSON.stringify(recovered.result).includes('HOST_PENDING_RESULT 43') &&
          executePosts === 1 &&
          observedStates.includes('running') &&
          pids.every((pid) => pid !== process.pid) &&
          new Set(pids).size === pids.length &&
          currentIncarnation.incarnation === c.incarnation.incarnation,
        { accepted, recovered, executePosts, observedStates, pids, currentIncarnation }
      );
      const cached = await call('notebook_execute', originalArgs);
      check(
        'Recovered runId is deduplicated after terminal caching',
        cached.state === 'completed' &&
          cached.requestId === accepted.requestId &&
          requests.filter((r) => r.method === 'POST' && r.route.endsWith('/execute')).length === 1,
        { cached, executePosts }
      );
      const oldNote = await call('notebook_read_cell', { notebookId, cellId: 'edge-note' });
      c.doc.notebook.cells.find((cell) => cell.id === 'edge-note').source =
        'Human note changed independently; preserve this wording.';
      await c.doc.flush();
      const conflict = await call('notebook_edit_cell', {
        notebookId,
        cellId: 'edge-note',
        expectedSourceHash: oldNote.sourceHash,
        source: 'Obsolete agent text',
      });
      await c.doc.flush();
      check(
        'Observed stale sourceHash edit is refused and human wording retained',
        conflict.state === 'conflict' &&
          c.doc
            .snapshot()
            .cells.find((x) => x.id === 'edge-note')
            .source.includes('changed independently'),
        conflict
      );
      const fresh = await call('notebook_read_cell', { notebookId, cellId: 'edge-note' });
      const edited = await call('notebook_edit_cell', {
        notebookId,
        cellId: 'edge-note',
        expectedSourceHash: fresh.sourceHash,
        source: fresh.source + '\nAgent append: synthetic acceptance only.',
      });
      await c.doc.flush();
      const note = c.doc.snapshot().cells.find((x) => x.id === 'edge-note');
      check(
        'MVP source-only edit retains unknown metadata and attachment',
        edited.state === 'edited' &&
          JSON.stringify(note.metadata) === JSON.stringify(markdown.metadata) &&
          JSON.stringify(note.attachments) === JSON.stringify(markdown.attachments),
        { edited, metadata: note.metadata, attachments: note.attachments }
      );
    });
  }
);

await isolated('kernel-incarnation', ["print('INCARNATION_PROBE')"], async (c) => {
  await client.json('api/kernels/' + c.kernelId + '/restart', 'POST', {});
  let next;
  const deadline = Date.now() + 12000;
  do {
    try {
      next = await client.kernelInfo(c.kernelId);
      if (next.incarnation !== c.incarnation.incarnation) break;
    } catch {}
    await wait(120);
  } while (Date.now() < deadline);
  check(
    'Remote protocol exposes changed incarnation after owned kernel restart',
    !!next?.incarnation &&
      next.kernelId === c.kernelId &&
      next.incarnation !== c.incarnation.incarnation,
    { before: c.incarnation, after: next }
  );
});

await isolated(
  'output-features',
  [
    "from IPython.display import display\nh = display({'text/plain':'DISPLAY_BEFORE','text/html':'<b>DISPLAY_BEFORE</b>'},raw=True,display_id=True)\nh.update({'text/plain':'DISPLAY_AFTER','text/html':'<b>DISPLAY_AFTER</b>'},raw=True)",
    "import time\nfrom IPython.display import clear_output, display\nprint('CLEAR_BEFORE',flush=True)\nclear_output(wait=True)\ntime.sleep(1.5)\ndisplay({'text/plain':'CLEAR_AFTER','text/html':'<i>CLEAR_AFTER</i>'},raw=True)",
    "import sys\nprint('STDOUT_MARKER',flush=True)\nprint('STDERR_MARKER',file=sys.stderr,flush=True)\nraise ValueError('SYNTHETIC_ERROR')",
  ],
  async (c) => {
    const { default: WebSocket } = await import('ws');
    const options = await client.socket(
      `api/kernels/${c.kernelId}/channels?session_id=${randomUUID()}`
    );
    const observer = new WebSocket(options.url, {
      headers: options.headers,
      followRedirects: false,
      handshakeTimeout: 12000,
      maxPayload: 1024 * 1024,
    });
    const messages = [];
    observer.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (
          message.channel === 'iopub' &&
          ['display_data', 'update_display_data', 'clear_output'].includes(message.header?.msg_type)
        )
          messages.push({
            type: message.header.msg_type,
            content: message.content,
            parentMessageId: message.parent_header?.msg_id,
          });
      } catch {}
    });
    observer.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        observer.once('open', resolve);
        observer.once('error', reject);
      });
      await wait(150);
      for (let index = 0; index < c.sources.length; index++) {
        const handle = await submit(c, 'edge-' + index, c.sources[index]);
        if (index === 1) {
          const deadline = Date.now() + 8000;
          while (!messages.some((m) => m.type === 'clear_output') && Date.now() < deadline)
            await wait(30);
          if (!messages.some((m) => m.type === 'clear_output'))
            throw new Error('Owned clear_output message was not observed');
          await wait(120);
          await c.doc.flush();
          const pending = await peek(handle);
          if (pending.httpStatus !== 202)
            throw new Error('clear_output wait interval was not observed before completion');
          const pendingCell = c.doc.snapshot().cells[index];
          check(
            'clear_output(wait=True) retains previous output until replacement arrives',
            stdout(pendingCell).includes('CLEAR_BEFORE'),
            {
              pending,
              outputs: pendingCell.outputs,
              kernelMessages: messages.filter((m) => m.type === 'clear_output'),
            }
          );
        }
        const result = await terminal(handle);
        await wait(200);
        await c.doc.flush();
        const cell = c.doc.snapshot().cells[index];
        if (index === 0) {
          const mime = cell.outputs.filter((o) => o.output_type === 'display_data');
          check(
            'Kernel emits the requested update_display_data',
            messages.some(
              (m) =>
                m.type === 'update_display_data' &&
                m.content?.data?.['text/plain'] === 'DISPLAY_AFTER'
            ),
            messages
          );
          check(
            'display_id update retains the latest plain/HTML MIME in the live cell',
            result.result?.status === 'ok' &&
              mime.some(
                (o) =>
                  o.data?.['text/plain'] === 'DISPLAY_AFTER' &&
                  o.data?.['text/html'] === '<b>DISPLAY_AFTER</b>'
              ) &&
              !JSON.stringify(cell.outputs).includes('DISPLAY_BEFORE'),
            { request: result, outputs: cell.outputs, kernelMessages: messages }
          );
        } else if (index === 1) {
          check(
            'clear_output(wait=True) clears earlier output before the next display',
            result.result?.status === 'ok' &&
              JSON.stringify(cell.outputs).includes('CLEAR_AFTER') &&
              !JSON.stringify(cell.outputs).includes('CLEAR_BEFORE'),
            { request: result, outputs: cell.outputs }
          );
        } else {
          const items = outputs(result.result);
          check(
            'Native stdout/stderr and structured Python errors remain distinguishable',
            result.httpStatus === 200 &&
              result.result?.status === 'error' &&
              stdout(result.result).includes('STDOUT_MARKER') &&
              items.some(
                (o) =>
                  o.output_type === 'stream' &&
                  o.name === 'stderr' &&
                  o.text.includes('STDERR_MARKER')
              ) &&
              items.some(
                (o) =>
                  o.output_type === 'error' &&
                  o.ename === 'ValueError' &&
                  o.evalue === 'SYNTHETIC_ERROR'
              ),
            { request: result, outputs: cell.outputs }
          );
        }
      }
    } finally {
      observer.close();
    }
  }
);

await isolated('document-identity', ["print('DOCUMENT_IDENTITY')"], async (c) => {
  const renamed = c.file.replace('.ipynb', '-renamed.ipynb');
  const originalId = c.doc.documentId;
  await c.doc.flush();
  await wait(1300);
  await client.json('api/contents/' + c.file, 'PATCH', { path: renamed });
  report.ownedNotebooks.push(renamed);
  persist();
  await client.json('api/sessions/' + c.session.id, 'PATCH', { path: renamed });
  let renamedDoc, copyDoc;
  try {
    renamedDoc = await client.openDocument(renamed, originalId);
    check(
      'Remote Notebook rename preserves RTC document identity',
      renamedDoc.documentId === originalId,
      { originalPath: c.file, newPath: renamed, originalId, currentId: renamedDoc.documentId }
    );
    const copy = await client.json('api/contents', 'POST', {
      copy_from: renamed,
      type: 'notebook',
    });
    report.ownedNotebooks.push(copy.path);
    persist();
    copyDoc = await client.openDocument(copy.path);
    check(
      'Remote Notebook copy receives a distinct RTC document identity',
      copyDoc.documentId !== originalId,
      { originalId, copyId: copyDoc.documentId, copyPath: copy.path }
    );
  } finally {
    renamedDoc?.close();
    copyDoc?.close();
  }
});

await isolated('terminal-host-recovery', ["print('UNCACHED_TERMINAL_RESULT', 47)"], async (c) => {
  await withCLI(c, 'terminal-host-recovery', async (f) => {
    const runId = 'unread-original-terminal';
    const accepted = await f.call('notebook_execute', await f.args('edge-0', runId));
    if (accepted.state !== 'accepted') throw new Error('Original submission was not accepted');
    const handle = { kernelId: c.kernelId, requestId: accepted.requestId };
    const firstConsumer = await terminal(handle);
    const secondConsumer = await peek(handle);
    const recovered = await freshStatus(f, runId);
    check(
      'New Node process recovers an uncached terminal result after other consumers read first',
      firstConsumer.result?.status === 'ok' &&
        secondConsumer.result?.status === 'ok' &&
        recovered.pid !== process.pid &&
        recovered.executePosts === 0 &&
        recovered.result.state === 'completed' &&
        recovered.result.requestId === accepted.requestId &&
        recovered.result.result?.outputs?.some((o) =>
          o.text?.includes('UNCACHED_TERMINAL_RESULT 47')
        ) &&
        recovered.requests.some((r) => r.route.endsWith('/requests/' + accepted.requestId)) &&
        !recovered.requests.some((r) => r.route.includes('collaboration')),
      { accepted, firstConsumer, secondConsumer, recovered }
    );
    const offline = await freshStatus(f, runId, true);
    check(
      'Independent offline Node process reads a cached terminal with complete result reference',
      offline.result.state === 'completed' &&
        offline.result.requestId === accepted.requestId &&
        offline.requests.length === 0 &&
        offline.executePosts === 0 &&
        typeof offline.result.originalResultEntry === 'string',
      offline
    );
  });
});

// CLI startup/RTC teardown has observable latency. Keep these executions busy
// until the test explicitly releases its own marker through Contents API.
const moveRelease = 'disclaude-cli-move-release-' + randomUUID() + '.txt';
const deleteRelease = 'disclaude-cli-delete-release-' + randomUUID() + '.txt';
const gatedSource = (marker, release, finished) =>
  'import pathlib,time\nprint(' +
  JSON.stringify(marker) +
  ',flush=True)\ndeadline=time.monotonic()+90\nwhile not pathlib.Path(' +
  JSON.stringify(release) +
  ').exists():\n    if time.monotonic()>deadline: raise TimeoutError("Probe release was not received")\n    time.sleep(0.05)\nprint(' +
  JSON.stringify(finished) +
  ')';
await isolated(
  'move-delete-running',
  [
    gatedSource('MOVE_BEGIN', moveRelease, 'MOVE_ORIGINAL_END'),
    gatedSource('DELETE_BEGIN', deleteRelease, 'DELETED_ORIGINAL_END'),
  ],
  async (c) => {
    for (const file of [moveRelease, deleteRelease]) {
      const absent = await client.response('api/contents/' + file);
      const missing = absent.status === 404;
      await absent.body?.cancel();
      if (!missing) throw new Error('Release marker is not an owned absent file');
    }
    report.ownedFiles ??= [];
    report.ownedFiles.push(moveRelease, deleteRelease);
    try {
      await withCLI(c, 'move-delete-running', async (f) => {
        const a = await f.call('notebook_execute', await f.args('edge-0', 'move-original'));
        const handleA = { kernelId: c.kernelId, requestId: a.requestId };
        await active(handleA, 'MOVE_BEGIN');
        const source = await f.call('notebook_read_cell', {
          notebookId: f.notebookId,
          cellId: 'edge-0',
        });
        const moved = await f.call('notebook_move_cell', {
          notebookId: f.notebookId,
          cellId: 'edge-0',
          expectedSourceHash: source.sourceHash,
          beforeCellId: '',
        });
        await wait(120);
        const edited = await f.call('notebook_edit_cell', {
          notebookId: f.notebookId,
          cellId: 'edge-0',
          expectedSourceHash: source.sourceHash,
          source: "print('MOVE_NEW_SOURCE')",
        });
        await wait(120);
        await c.doc.flush();
        const immediate = c.doc.snapshot().cells.find((cell) => cell.id === 'edge-0');
        const pending = await peek(handleA);
        check(
          'Native cell move rebinds source observation and clears edited outputs while still running',
          moved.state === 'moved' &&
            edited.state === 'edited' &&
            pending.httpStatus === 202 &&
            immediate.source === "print('MOVE_NEW_SOURCE')" &&
            immediate.outputs.length === 0,
          { moved, edited, immediate, pending }
        );
        await client.json('api/contents/' + moveRelease, 'PUT', {
          type: 'file',
          format: 'text',
          content: 'release',
        });
        const original = await f.status('move-original');
        const currentAccepted = await f.call(
          'notebook_execute',
          await f.args('edge-0', 'move-new')
        );
        const current = await f.status('move-new');
        const retained = await peek(handleA);
        await c.doc.flush();
        const newCell = c.doc.snapshot().cells.find((cell) => cell.id === 'edge-0');
        check(
          'Next run owns the moved cell while the original source/result remains historical',
          original.state === 'completed' &&
            original.result.sourceMatches === false &&
            original.result.outputAttachment === 'historical' &&
            currentAccepted.state === 'accepted' &&
            current.state === 'completed' &&
            stdout(newCell).includes('MOVE_NEW_SOURCE') &&
            !stdout(newCell).includes('MOVE_ORIGINAL_END') &&
            stdout(retained.result).includes('MOVE_ORIGINAL_END') &&
            retained.result.source === c.sources[0],
          { original, current, retained, newCell }
        );
        const b = await f.call('notebook_execute', await f.args('edge-1', 'delete-original'));
        const handleB = { kernelId: c.kernelId, requestId: b.requestId };
        await active(handleB, 'DELETE_BEGIN');
        const { notebookId, cellId, expectedSourceHash } = await f.args(
          'edge-1',
          'unused-delete-read'
        );
        const removed = await f.call('notebook_delete_cell', {
          notebookId,
          cellId,
          expectedSourceHash,
        });
        await f.call('notebook_insert_cell', {
          notebookId: f.notebookId,
          cellId: 'replacement-cell',
          beforeCellId: '',
          cellType: 'code',
          source: "print('REPLACEMENT_RESULT')",
        });
        const deletePending = await peek(handleB);
        await c.doc.flush();
        check(
          'Stable cell deletion happens while the original execution is pending',
          deletePending.httpStatus === 202 &&
            !c.doc.snapshot().cells.some((cell) => cell.id === 'edge-1'),
          { removed, deletePending }
        );
        await client.json('api/contents/' + deleteRelease, 'PUT', {
          type: 'file',
          format: 'text',
          content: 'release',
        });
        const deleted = await f.status('delete-original');
        const replacementAccepted = await f.call(
          'notebook_execute',
          await f.args('replacement-cell', 'replacement-run')
        );
        const replacement = await f.status('replacement-run');
        await c.doc.flush();
        const snapshot = c.doc.snapshot();
        const note = snapshot.cells.find((cell) => cell.id === 'edge-note');
        check(
          'Deleting a running stable cell retains original history and isolates its replacement',
          removed.state === 'deleted' &&
            deleted.state === 'completed' &&
            deleted.result.sourceMatches === false &&
            replacementAccepted.state === 'accepted' &&
            replacement.state === 'completed' &&
            !snapshot.cells.some((cell) => cell.id === 'edge-1') &&
            !snapshot.cells.some((cell) => stdout(cell).includes('DELETED_ORIGINAL_END')) &&
            JSON.stringify(note.metadata) === JSON.stringify(markdown.metadata) &&
            JSON.stringify(note.attachments) === JSON.stringify(markdown.attachments),
          { removed, deleted, replacement, snapshot }
        );
      });
    } finally {
      for (const file of [moveRelease, deleteRelease]) {
        const response = await client.response('api/contents/' + file, 'DELETE');
        const ok = [204, 404].includes(response.status);
        await response.body?.cancel();
        if (!ok) throw new Error('Owned release marker cleanup failed');
      }
    }
  }
);

await isolated(
  'display-many-positions',
  [
    "from IPython.display import display\nshared_display='disclaude-multi-display'\ndisplay({'text/plain':'MULTI_BEFORE_A','text/html':'<b>MULTI_BEFORE_A</b>'},raw=True,display_id=shared_display)\ndisplay({'text/plain':'MULTI_BEFORE_A2'},raw=True,display_id=shared_display)",
    "display({'text/plain':'MULTI_BEFORE_B'},raw=True,display_id=shared_display)",
    "from IPython.display import update_display\nupdate_display({'text/plain':'MULTI_AFTER','text/html':'<b>MULTI_AFTER</b>'},raw=True,display_id=shared_display)",
  ],
  async (c) => {
    await watchOutputs(c, async (messages) => {
      const handles = [];
      for (let i = 0; i < c.sources.length; i++) {
        const handle = await submit(c, 'edge-' + i, c.sources[i]);
        handles.push(handle);
        if ((await terminal(handle)).result?.status !== 'ok')
          throw new Error('Display execution failed');
      }
      await wait(200);
      await c.doc.flush();
      const cells = c.doc.snapshot().cells;
      const targets = [...cells[0].outputs, ...cells[1].outputs].filter(
        (o) => o.output_type === 'display_data'
      );
      const historical = await peek(handles[0]);
      check(
        'One display_id updates every position across two cells through native IOPub',
        targets.length === 3 &&
          targets.every(
            (o) =>
              o.data?.['text/plain'] === 'MULTI_AFTER' &&
              o.data?.['text/html'] === '<b>MULTI_AFTER</b>'
          ) &&
          messages.filter((m) => m.type === 'display_data').length === 3 &&
          messages.some(
            (m) =>
              m.type === 'update_display_data' &&
              m.content.transient?.display_id === 'disclaude-multi-display'
          ),
        {
          outputs: cells.slice(0, 3).map((cell) => ({ id: cell.id, outputs: cell.outputs })),
          messages,
        }
      );
      check(
        'A later display update does not rewrite the already-retained original run result',
        outputs(historical.result)
          .filter((o) => o.output_type === 'display_data')
          .every((o) => o.data?.['text/plain']?.startsWith('MULTI_BEFORE_A')),
        { historical, currentTargets: targets }
      );
    });
  }
);

await isolated(
  'clear-immediate',
  [
    "import time\nfrom IPython.display import clear_output,display\nprint('IMMEDIATE_BEFORE',flush=True)\nclear_output(wait=False)\ntime.sleep(1.5)\ndisplay({'text/plain':'IMMEDIATE_AFTER'},raw=True)",
  ],
  async (c) => {
    await watchOutputs(c, async (messages) => {
      const handle = await submit(c, 'edge-0', c.sources[0]);
      const deadline = Date.now() + 8000;
      while (!messages.some((m) => m.type === 'clear_output') && Date.now() < deadline)
        await wait(30);
      await wait(120);
      await c.doc.flush();
      const beforeReplacement = c.doc.snapshot().cells[0];
      const pending = await peek(handle);
      check(
        'clear_output(wait=False) empties the live cell before the next output',
        messages.some((m) => m.type === 'clear_output' && m.content.wait === false) &&
          pending.httpStatus === 202 &&
          beforeReplacement.outputs.length === 0,
        { pending, beforeReplacement, messages }
      );
      const complete = await terminal(handle);
      await wait(120);
      await c.doc.flush();
      const cell = c.doc.snapshot().cells[0];
      check(
        'Immediate clear retains only the replacement in the final Notebook',
        complete.result?.status === 'ok' &&
          JSON.stringify(cell.outputs).includes('IMMEDIATE_AFTER') &&
          !JSON.stringify(cell.outputs).includes('IMMEDIATE_BEFORE'),
        { complete, cell }
      );
    });
  }
);

await isolated(
  'large-output-stdin',
  [
    "from IPython.display import display\nprint('LARGE_BEGIN'+('x'*80000)+'LARGE_END')\nfor i in range(21): display({'text/plain':f'OUTPUT_POSITION_{i}'},raw=True)",
    "input('THIS_MUST_BE_EXPLICITLY_REJECTED:')",
  ],
  async (c) => {
    await withCLI(c, 'large-output-stdin', async (f) => {
      const accepted = await f.call('notebook_execute', await f.args('edge-0', 'large-original'));
      const result = await f.status('large-original');
      const pathName = result.result?.resultArtifact;
      if (typeof pathName !== 'string')
        throw new Error('Large result omitted its complete artifact');
      const artifactResponse = await client.response('files/' + pathName);
      if (!artifactResponse.ok) {
        await artifactResponse.body?.cancel();
        throw new Error(
          'Authenticated complete artifact GET failed: HTTP ' + artifactResponse.status
        );
      }
      const artifact = JSON.parse(await artifactResponse.text());
      const anonymous = await fetch(result.resultArtifactEntry, { redirect: 'manual' });
      const anonymousStatus = anonymous.status;
      await anonymous.body?.cancel();
      const read = await f.call('notebook_read_cell', {
        notebookId: f.notebookId,
        cellId: 'edge-0',
      });
      check(
        'Large status/RTC previews disclose truncation and reference the complete authenticated artifact',
        accepted.state === 'accepted' &&
          result.state === 'completed' &&
          result.result.outputsTruncated === true &&
          typeof result.originalResultEntry === 'string' &&
          typeof result.resultArtifactEntry === 'string' &&
          stdout(artifact).includes('LARGE_END') &&
          stdout(artifact).length > 80000 &&
          outputs(artifact).length === 22 &&
          read.outputsTruncated === true &&
          read.outputs.length === 16 &&
          read.omittedOutputs === 6 &&
          [302, 303, 401, 403].includes(anonymousStatus),
        {
          accepted,
          result,
          artifactBytes: artifact.result_bytes ?? Buffer.byteLength(JSON.stringify(artifact)),
          completeOutputs: outputs(artifact).length,
          preview: read,
          anonymousStatus,
          csp: artifactResponse.headers.get('content-security-policy'),
        }
      );
      await f.call('notebook_execute', await f.args('edge-1', 'stdin-rejected'));
      const stdin = await f.status('stdin-rejected');
      check(
        'Host execution explicitly refuses stdin rather than hanging for invisible input',
        stdin.state === 'failed' && stdin.result?.error?.ename === 'StdinNotImplementedError',
        stdin
      );
    });
  }
);

await isolated(
  'completion-cancel-race',
  [
    "import time\nprint('RACE_A_BEGIN',flush=True)\ntime.sleep(0.2)\nprint('RACE_A_DONE')",
    "import time\nprint('RACE_B_BEGIN',flush=True)\ntime.sleep(0.4)\nprint('RACE_B_DONE')",
  ],
  async (c) => {
    const trials = [];
    for (const delay of [0, 120, 190, 230, 300]) {
      const a = await submit(c, 'edge-0', c.sources[0]);
      await active(a, 'RACE_A_BEGIN');
      const b = await submit(c, 'edge-1', c.sources[1]);
      await wait(delay);
      const before = await peek(a);
      const cancel = await client.stopRequest(a);
      const aFinal = await terminal(a),
        bFinal = await terminal(b);
      trials.push({ delay, a, b, before, cancel, aFinal, bFinal });
    }
    check(
      'Cancellation racing completion and next dispatch never interrupts the other request',
      trials.every(
        (t) =>
          t.cancel === 'requested' &&
          t.aFinal.httpStatus !== 202 &&
          t.bFinal.result?.status === 'ok' &&
          stdout(t.bFinal.result).includes('RACE_B_DONE')
      ),
      trials
    );
  }
);

await isolated(
  'cli-stop-continuation',
  [
    "import time\nstop_memory=37\nprint('SERVICE_STOP_BEGIN',flush=True)\ntime.sleep(20)\nprint('SERVICE_STOP_LATE')",
    "print('SERVICE_SAME_KERNEL',stop_memory+5)",
  ],
  async (c) => {
    await withCLI(c, 'cli-stop-continuation', async (f) => {
      const accepted = await f.call('notebook_execute', await f.args('edge-0', 'service-long'));
      await active({ kernelId: c.kernelId, requestId: accepted.requestId }, 'SERVICE_STOP_BEGIN');
      const stopped = await f.call('notebook_stop', {
        notebookId: f.notebookId,
        runId: 'service-long',
      });
      const exact = await peek({ kernelId: c.kernelId, requestId: accepted.requestId });
      const nextArgs = await f.args('edge-1', 'service-continue');
      const continued = await f.call('notebook_execute', nextArgs);
      const complete = await f.status('service-continue');
      const incarnation = await client.kernelInfo(c.kernelId);
      check(
        'Explicit CLI stop confirms the original request before same-kernel continuation',
        stopped.state === 'cancelled' &&
          stopped.stopConfirmed === true &&
          outputs(exact.result).some((o) => o.ename === 'KeyboardInterrupt') &&
          !stdout(exact.result).includes('SERVICE_STOP_LATE') &&
          continued.state === 'accepted' &&
          complete.state === 'completed' &&
          complete.result?.outputs?.some((o) => o.text?.includes('SERVICE_SAME_KERNEL 42')) &&
          incarnation.incarnation === c.incarnation.incarnation &&
          f.requests.filter((r) => r.method === 'POST' && r.route.endsWith('/execute')).length ===
            2,
        { stopped, exact, continued, complete, incarnation, requests: f.requests }
      );
    });
  }
);

await isolated('export-revision-race', ["print('EXPORT_RECORDED_RESULT')"], async (c) => {
  await withCLI(c, 'export-revision-race', async (f) => {
    await f.call('notebook_execute', await f.args('edge-0', 'export-original'));
    const complete = await f.status('export-original');
    let changed = false;
    f.probe.traffic.onResponse = async ({ route, method }) => {
      if (route === 'nbconvert/html' && method === 'POST' && !changed) {
        changed = true;
        c.doc.notebook.cells.find((cell) => cell.id === 'edge-note').source =
          'Human edit during export; keep live.';
        await c.doc.flush();
      }
    };
    const exported = await f.call('notebook_export', { notebookId: f.notebookId });
    const notebook = await client.json('api/contents/' + exported.notebookPath);
    const htmlResponse = await client.response('files/' + exported.htmlPath);
    if (!htmlResponse.ok) {
      await htmlResponse.body?.cancel();
      throw new Error('Authenticated HTML file GET failed: HTTP ' + htmlResponse.status);
    }
    const html = await htmlResponse.text();
    await c.doc.flush();
    const live = c.doc.snapshot().cells.find((cell) => cell.id === 'edge-note');
    check(
      'Concurrent live edit is diagnosed while HTML and ipynb retain one historical snapshot',
      complete.state === 'completed' &&
        changed &&
        exported.liveChangedDuringExport === true &&
        exported.snapshotState === 'historical' &&
        exported.revision !== exported.liveRevision &&
        notebook.content.cells.find((cell) => cell.id === 'edge-note').source === markdown.source &&
        html.includes(markdown.source) &&
        html.includes('disclaude-snapshot-sha256') &&
        html.includes(exported.revision) &&
        live.source === 'Human edit during export; keep live.',
      {
        exported,
        live,
        csp: htmlResponse.headers.get('content-security-policy'),
        contentType: htmlResponse.headers.get('content-type'),
      }
    );
    report.ownedNotebooks.push(exported.notebookPath, exported.htmlPath);
    persist();
  });
});

const remainingKernels = await client.json('api/kernels'),
  remainingSessions = await client.json('api/sessions');
report.originalKernelsPreserved = originalKernels.every((k) =>
  remainingKernels.some((after) => after.id === k.id)
);
report.originalSessionsPreserved = originalSessions.every((s) =>
  remainingSessions.some((after) => after.id === s.id)
);
report.resourceCounts = {
  kernels: [originalKernels.length, remainingKernels.length],
  sessions: [originalSessions.length, remainingSessions.length],
};
report.completed = !report.cleanupErrors && !report.operationErrors;
report.finishedAt = new Date().toISOString();
persist();
console.log(
  JSON.stringify({
    output: root,
    completed: report.completed,
    checks: report.checks.length,
    passed: report.checks.filter((c) => c.passed).length,
    resourceCounts: report.resourceCounts,
  })
);
if (
  !report.completed ||
  report.checks.some((c) => !c.passed) ||
  !report.originalKernelsPreserved ||
  !report.originalSessionsPreserved
)
  process.exitCode = 1;

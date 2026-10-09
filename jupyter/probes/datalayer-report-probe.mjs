import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatalayerJupyterClient } from '../../packages/core/dist/jupyter/datalayer-client.js';
import {
  createCLIProbe,
  probeSource,
  probeAuth,
  probeConnection,
  probeKernel,
} from './cli-probe-client.mjs';
import { notebookSnapshotHash } from '../../packages/core/dist/jupyter/notebook-fingerprint.js';
import { reportStudySource, reportInteraction } from './display-fixtures.mjs';

const { values } = parseArgs({
  options: {
    'env-file': { type: 'string' },
    output: { type: 'string' },
    'kernel-name': { type: 'string' },
  },
});
if (!values.output) {
  throw new Error('A fresh private output directory required');
}
const root = path.resolve(values.output);
fs.mkdirSync(root, { mode: 0o700 });
const auth = await probeAuth(values['env-file']);
const client = new DatalayerJupyterClient({
  ...probeConnection(auth),
  allowInsecureHttp: true,
  maxResponseBytes: 8_000_000,
});
const before = {
  kernels: await client.json('api/kernels'),
  sessions: await client.json('api/sessions'),
};
const nonce = randomUUID().slice(0, 8);
const report = {
  source: probeSource(),
  startedAt: new Date().toISOString(),
  scope:
    'Configured remote CSV input, standard-library PNG/SVG/HTML artifacts and two clean kernel numerical reproductions; native device rendering/Feishu remain separate',
  checks: [],
  ownedNotebooks: [],
  runs: [],
  exports: [],
};
const persist = () => {
  const content = JSON.stringify(report, null, 2);
  if (content.includes(auth.secret)) {
    throw new Error('Credential reached evidence');
  }
  fs.writeFileSync(path.join(root, 'report.json'), content + '\n', { mode: 0o600 });
};
const check = (name, passed, evidence) => {
  report.checks.push({ name, passed, evidence });
  persist();
  console.log(JSON.stringify({ name, passed }));
};
const csv = 'group,value\nA,3\nB,7\nC,2\n';
const localPath = path.join(root, 'synthetic-input.csv');
fs.writeFileSync(localPath, csv, { mode: 0o600 });
report.dataset = {
  kind: 'synthetic CSV, no external claims',
  sha256: createHash('sha256').update(csv).digest('hex'),
  seed: 63,
  rows: 3,
  reproducibility:
    'Numerical results with these input bytes, seed and recorded Python version. Runtime IDs and report paths are not byte reproducibility claims.',
};
const sessions = [];
const run = async (owner, id, runId) => {
  const cell = await owner.call('notebook_read_cell', { notebookId: id, cellId: 'study-analysis' });
  const submitted = await owner.call('notebook_execute', {
    notebookId: id,
    cellId: 'study-analysis',
    expectedSourceHash: cell.sourceHash,
    runId,
  });
  if (submitted.state !== 'accepted') throw new Error('Original study submission not accepted');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const result = await owner.call('notebook_status', { notebookId: id, runId });
    if (['completed', 'failed', 'cancelled', 'unknown'].includes(result.state)) {
      report.runs.push(result);
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Study original request did not finish');
};
try {
  const spec = await probeKernel(client, values['kernel-name']);
  const kernelName = spec.name;
  report.kernel = {
    name: kernelName,
    displayName: spec.display_name,
    language: spec.language,
  };
  const reproductions = [];
  for (let trial = 0; trial < 2; trial++) {
    const notebook = `disclaude-datalayer-report-${nonce}-${trial}.ipynb`;
    const absent = await client.response(`api/contents/${notebook}`);
    if (absent.status !== 404) {
      throw new Error('Owned scratch Notebook name collision');
    }
    await absent.body?.cancel();
    await client.json(`api/contents/${notebook}`, 'PUT', {
      type: 'notebook',
      format: 'json',
      content: {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: {
            name: kernelName,
            display_name: spec.display_name,
            language: spec.language,
          },
        },
        cells: [
          {
            id: 'human-note',
            cell_type: 'markdown',
            metadata: { unrecognized: { keep: true } },
            source:
              '# Synthetic CSV study\n\nHuman note: preserve this wording.\n\nFormula: $\\bar{x}=\\frac{1}{n}\\sum x_i$.\n\n| Input | Rows | Seed |\n|---|---:|---:|\n| synthetic CSV | 3 | 63 |',
          },
          {
            id: 'study-analysis',
            cell_type: 'code',
            source: '',
            metadata: {},
            execution_count: null,
            outputs: [],
          },
        ],
      },
    });
    report.ownedNotebooks.push(notebook);
    if (values['kernel-name'])
      await client.json('api/sessions', 'POST', {
        path: notebook,
        name: notebook,
        type: 'notebook',
        kernel: { name: kernelName },
      });
    const project = path.join(root, `project-${trial}`);
    fs.mkdirSync(project, { mode: 0o700 });
    const session = await createCLIProbe({
      envFile: values['env-file'],
      project,
      directory: project,
    });
    sessions.push(session);
    const linked = await session.command('link', undefined, ['--path', notebook]);
    const id = linked.notebookId;
    const invoke = session.call;
    fs.copyFileSync(localPath, path.join(project, 'synthetic-input.csv'));
    const imported = await invoke('notebook_import_file', {
      notebookId: id,
      filePath: 'synthetic-input.csv',
    });
    const repeated = await invoke('notebook_import_file', {
      notebookId: id,
      filePath: 'synthetic-input.csv',
    });
    check(
      `Remote CSV import ${trial} preserves bytes and verifies repeat`,
      imported.state === 'imported' &&
        repeated.state === 'existing' &&
        imported.sha256 === report.dataset.sha256,
      { imported, repeated }
    );
    const source = reportStudySource(imported.kernelRelativePath);
    const initial = await invoke('notebook_read_cell', {
      notebookId: id,
      cellId: 'study-analysis',
    });
    await invoke('notebook_edit_cell', {
      notebookId: id,
      cellId: 'study-analysis',
      expectedSourceHash: initial.sourceHash,
      source,
    });
    const result = await run(session, id, `study-${trial}`);
    check(`Clean remote study execution ${trial}`, result.state === 'completed', result);
    if (result.state !== 'completed')
      throw new Error(result.result?.error?.evalue ?? 'Remote study execution failed');
    const peer = await client.openDocument(notebook, linked.documentId);
    let snapshot, notebookJSON;
    try {
      await peer.flush();
      snapshot = peer.snapshot();
      notebookJSON = peer.notebook.toJSON();
    } finally {
      peer.close();
    }
    const cell = snapshot.cells.find((cell) => cell.id === 'study-analysis');
    const outputs = cell.outputs ?? [];
    const stdout = outputs
      .filter((output) => output.output_type === 'stream')
      .map((output) => (Array.isArray(output.text) ? output.text.join('') : output.text))
      .join('');
    const match = stdout.match(/STUDY_RESULT (\{[^\n]+\})/);
    if (!match) {
      throw new Error('Study numerical result missing from native Notebook');
    }
    const summary = JSON.parse(match[1]);
    reproductions.push(summary);
    const mimes = outputs.flatMap((output) => Object.keys(output.data ?? {}));
    check(
      `Native MIME outputs and human note ${trial}`,
      ['image/png', 'image/svg+xml', 'text/html'].every((mime) => mimes.includes(mime)) &&
        snapshot.cells[0].source.includes('preserve this wording') &&
        snapshot.cells[0].metadata.unrecognized.keep,
      {
        mimes,
        summary,
        outputBytes: Buffer.byteLength(JSON.stringify(outputs)),
        sourceHash: cell.sourceHash,
      }
    );
    const imageIndex = outputs.findIndex((output) => output.data?.['image/png']);
    const image = await invoke('notebook_observe_image', {
      notebookId: id,
      cellId: 'study-analysis',
      outputIndex: imageIndex,
    });
    check(
      `Bound native PNG observation ${trial}`,
      image.data.outputState === 'current' && image.images[0].mimeType === 'image/png',
      {
        metadata: image.data,
        imageSha256: createHash('sha256')
          .update(fs.readFileSync(image.images[0].filePath))
          .digest('hex'),
      }
    );
    fs.writeFileSync(
      path.join(root, `study-${trial}.png`),
      fs.readFileSync(image.images[0].filePath),
      { mode: 0o600 }
    );
    fs.writeFileSync(
      path.join(root, `study-${trial}.ipynb`),
      JSON.stringify(notebookJSON, null, 2) + '\n',
      { mode: 0o600 }
    );
  }
  check(
    'Two clean kernels reproduce the expected CSV statistics and seeded result',
    JSON.stringify(reproductions[0]) === JSON.stringify(reproductions[1]) &&
      reproductions[0].mean === 4 &&
      Math.abs(reproductions[0].sample_std - Math.sqrt(7)) < 1e-12 &&
      Number.isFinite(reproductions[0].seeded_mean) &&
      report.runs[0].kernelId !== report.runs[1].kernelId,
    {
      reproductions,
      kernels: report.runs.map((run) => ({ id: run.kernelId, incarnation: run.kernelIncarnation })),
    }
  );
  const exporter = sessions[0];
  const view = await exporter.call('notebook_list', {});
  const exported = await exporter.call('notebook_export', {
    notebookId: view.notebooks[0].notebookId,
  });
  report.exports.push(exported);
  const snapshot = await client.json(`api/contents/${exported.notebookPath}`);
  const revision = notebookSnapshotHash(snapshot.content);
  const response = await client.response(`files/${exported.htmlPath}`);
  const html = await client.responseText(response);
  const csp = response.headers.get('content-security-policy');
  check(
    'HTML/ipynb snapshot, inline interaction and output artifacts are consistent',
    response.ok &&
      revision === exported.revision &&
      html.includes(`content="${revision}"`) &&
      html.includes('HTML_REPORT_MARKER') &&
      html.includes('data-report-values="[3.0, 7.0, 2.0]"') &&
      html.includes(reportInteraction) &&
      html.includes('SVG_REPORT_MARKER') &&
      html.includes('data:image/png;base64'),
    {
      exported,
      htmlBytes: Buffer.byteLength(html),
      contentType: response.headers.get('content-type'),
      csp,
    }
  );
  const anonymous = await fetch(exported.htmlEntry, { redirect: 'manual' });
  await anonymous.body?.cancel();
  check(
    'Report authentication and sandbox headers are enforced',
    ![200, 201].includes(anonymous.status) &&
      csp?.includes('sandbox') &&
      !csp.includes('allow-same-origin'),
    {
      anonymousStatus: anonymous.status,
      csp,
      limitation:
        'Header/source inspection, not actual-device JavaScript or sanitizer rendering acceptance',
    }
  );
  fs.writeFileSync(
    path.join(root, 'report.ipynb'),
    JSON.stringify(snapshot.content, null, 2) + '\n',
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(root, 'report.html'), html, { mode: 0o600 });
  report.completed = report.checks.every((check) => check.passed);
} catch (error) {
  report.completed = false;
  report.error = error.message;
} finally {
  await Promise.all(sessions.map((session) => session.close()));
  report.commands = sessions.flatMap((session) => session.commands);
  const current = await client.json('api/sessions');
  for (const session of current.filter(
    (session) =>
      report.ownedNotebooks.includes(session.path) &&
      !before.sessions.some((original) => original.id === session.id)
  )) {
    await client.json(`api/sessions/${session.id}`, 'DELETE');
  }
  const after = {
    kernels: await client.json('api/kernels'),
    sessions: await client.json('api/sessions'),
  };
  report.originalResourcesPreserved =
    before.kernels.every((kernel) => after.kernels.some((item) => item.id === kernel.id)) &&
    before.sessions.every((session) => after.sessions.some((item) => item.id === session.id));
  report.resourceCounts = {
    kernels: [before.kernels.length, after.kernels.length],
    sessions: [before.sessions.length, after.sessions.length],
  };
  report.finishedAt = new Date().toISOString();
  persist();
  console.log(
    JSON.stringify({
      completed: report.completed,
      error: report.error,
      resourceCounts: report.resourceCounts,
    })
  );
  if (!report.completed || !report.originalResourcesPreserved) {
    process.exitCode = 1;
  }
}

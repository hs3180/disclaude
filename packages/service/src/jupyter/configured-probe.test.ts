import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const checkout = fileURLToPath(new URL('../../../../', import.meta.url));
const script = path.join(checkout, 'tests/jupyter/dsh-notebook-probe.mjs');
const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (cleanup) => await cleanup()));
});

async function fixture(coordinator: 'missing' | 'error' | 'available') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'configured-dsh-probe-fixture-'));
  cleanups.push(async () => await fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const credential = 'Bearer configured-probe-fixture-secret';
  const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const notebook = {
    identity: { connectionId: 'configured', serverNamespace: 'namespace', documentId: 'doc' },
    contentPath: 'scratch.ipynb',
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push({ path: request.url!, method: request.method!, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api' || request.url === '/api/status') {
      response.end(JSON.stringify({ version: '2.19.0' }));
    } else if (request.url === '/api/disclaude') {
      if (coordinator !== 'available') {
        response.statusCode = coordinator === 'missing' ? 404 : 500;
        response.end(JSON.stringify({ message: credential }));
      } else {
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            serverNamespace: 'namespace',
            stack: { server: 'fixture' },
            activeRooms: 0,
            pendingRooms: 0,
            roomFailures: {},
            maxRooms: 16,
            idleSeconds: 60,
          })
        );
      }
    } else if (request.url === '/api/disclaude/notebooks') {
      response.end(JSON.stringify(notebook));
    } else if (request.url === '/api/disclaude/notebooks/doc/control' && body.action === 'read') {
      response.end(JSON.stringify({ ownerId: 'human', generation: 2 }));
    } else {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: 'Unexpected mutating request' }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  const config = path.join(root, 'connections.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      version: 1,
      connections: [
        {
          id: 'configured',
          backend: 'coordinator',
          baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
          authorizationEnv: 'CONFIGURED_PROBE_FIXTURE_AUTH',
        },
      ],
    }),
    { mode: 0o600 }
  );
  const output = path.join(root, 'report.json');
  const binary = path.join(root, 'fixture-dsh.mjs');
  const marker = path.join(root, 'binary-calls.jsonl');
  await fs.writeFile(
    binary,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2))+"\\n");
console.log("0.1.2-rc.1");
`,
    { mode: 0o700 }
  );
  const auth = path.join(root, 'fixture-oauth.json');
  const access = [
    'header',
    Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 7200 })).toString('base64url'),
    'signature',
  ].join('.');
  await fs.writeFile(auth, JSON.stringify({ tokens: { access_token: access } }), { mode: 0o600 });
  async function run(extra: string[] = []) {
    let result;
    let code = 0;
    try {
      result = await execute(
        process.execPath,
        [
          script,
          '--config-file',
          config,
          '--connection-id',
          'configured',
          '--project-dir',
          project,
          '--dsh-checkout',
          checkout,
          '--oauth-auth-file',
          auth,
          '--model',
          'gpt-5.6-luna',
          '--binary',
          binary,
          '--notebook',
          'scratch.ipynb',
          '--output',
          output,
          ...extra,
        ],
        {
          cwd: root,
          timeout: 10000,
          env: {
            ...process.env,
            DISCLAUDE_JUPYTER_PROBE_TOKEN: undefined,
            CONFIGURED_PROBE_FIXTURE_AUTH: credential,
          },
        }
      );
    } catch (error) {
      const failure = error as { code: number; stdout: string; stderr: string };
      ({ code } = failure);
      result = { stdout: failure.stdout, stderr: failure.stderr };
    }
    const text = await fs.readFile(output, 'utf8');
    expect(text + result.stdout + result.stderr).not.toContain(credential);
    expect(text + result.stdout + result.stderr).not.toContain(access);
    return { code, report: JSON.parse(text) };
  }
  return { project, output, calls, marker, notebook, run };
}

describe('configured DSH Notebook probe', () => {
  it('exits blocked before any Notebook, model, temporary root or Project mutation on stock Jupyter', async () => {
    const f = await fixture('missing');
    const result = await f.run();
    expect(result.code).toBe(2);
    expect(result.report).toMatchObject({
      state: 'blocked',
      mode: 'configured',
      modelStarted: false,
      notebookOpened: false,
      ownedRootCreated: false,
      nativeLogInspection: 'not_executed',
      phases: [],
      configuredInspection: { coordinator: 'missing' },
    });
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(await fs.readdir(f.project)).toEqual([]);
    await expect(fs.stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a coordinator HTTP failure as failure, with reflected credentials omitted', async () => {
    const f = await fixture('error');
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.report).toMatchObject({
      state: 'failed',
      modelStarted: false,
      notebookOpened: false,
    });
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    await expect(fs.stat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses another controller without submitting, claiming or deleting Project data', async () => {
    const f = await fixture('available');
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.report.error).toContain('explicit handoff');
    expect(result.report).toMatchObject({
      modelStarted: false,
      projectPreserved: true,
      ownedRootRemoved: true,
    });
    expect(f.calls.filter((call) => call.method !== 'GET').map((call) => call.body)).toEqual([
      { contentPath: 'scratch.ipynb', connectionId: 'configured' },
      { notebook: f.notebook, action: 'read' },
    ]);
    expect(await fs.readFile(f.marker, 'utf8')).toBe('["--version"]\n');
    expect((await fs.stat(f.project)).isDirectory()).toBe(true);
  });

  it('preserves existing Project references when the requested Notebook differs', async () => {
    const f = await fixture('available');
    await fs.mkdir(path.join(f.project, '.jupyter'));
    const config = path.join(f.project, '.jupyter/config.json');
    const original = JSON.stringify({
      version: 1,
      notebooks: [
        {
          ...f.notebook.identity,
          documentId: 'another-document',
          contentPath: 'another.ipynb',
        },
      ],
    });
    await fs.writeFile(config, original);
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.report.error).toContain('different Notebook');
    expect(await fs.readFile(config, 'utf8')).toBe(original);
    expect(
      f.calls
        .filter((call) => call.path.endsWith('/control'))
        .every((call) => call.body.action === 'read')
    ).toBe(true);
    expect(result.report.modelStarted).toBe(false);
  });

  it('recognizes a stable Notebook identity after a path change and still requires handoff', async () => {
    const f = await fixture('available');
    await fs.mkdir(path.join(f.project, '.jupyter'));
    const config = path.join(f.project, '.jupyter/config.json');
    const original = JSON.stringify({
      version: 1,
      notebooks: [
        {
          ...f.notebook.identity,
          contentPath: 'previous-name.ipynb',
        },
      ],
    });
    await fs.writeFile(config, original);
    const result = await f.run();
    expect(result.code).toBe(1);
    expect(result.report.error).toContain('explicit handoff');
    expect(await fs.readFile(config, 'utf8')).toBe(original);
    expect(result.report.modelStarted).toBe(false);
  });
});

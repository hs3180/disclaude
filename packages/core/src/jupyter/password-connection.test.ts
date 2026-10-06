import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import nock from 'nock';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJupyterCookieJar, JupyterCoordinatorClient } from './coordinator-client.js';

const notebook = {
  identity: { connectionId: 'host', serverNamespace: 'namespace', documentId: 'document' },
  contentPath: 'report.ipynb',
};
const password = ' fixture +& password ';
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(closers.splice(0).map((close) => close()));
  nock.disableNetConnect();
});

async function fixture(
  options: {
    redirect?: string;
    wrongPassword?: boolean;
    noXsrf?: boolean;
    missing?: boolean;
    expireMutation?: boolean;
    publicStatus?: boolean;
  } = {}
) {
  const seen: Array<{
    path: string;
    method: string;
    body: string;
    cookie?: string;
    authorization?: string;
    xsrf?: string;
    origin?: string;
    referer?: string;
  }> = [];
  let principal = 'principal-1';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const body = Buffer.concat(chunks).toString();
    const path = request.url ?? '';
    const method = request.method ?? '';
    seen.push({
      path,
      method,
      body,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      xsrf: request.headers['x-xsrftoken'] as string | undefined,
      origin: request.headers.origin,
      referer: request.headers.referer,
    });
    const authenticated = request.headers.cookie?.includes(`owned-session=${principal}`);
    if (path === '/prefix/api/status') {
      response.writeHead(authenticated || options.publicStatus ? 200 : 403);
      response.end('{}');
    } else if (path === '/prefix/login' && method === 'GET') {
      if (!options.noXsrf) {
        response.setHeader('Set-Cookie', '_xsrf=2|signed|fixture; Path=/prefix/');
      }
      response.end('<form>Standard login</form>');
    } else if (path === '/prefix/login' && method === 'POST') {
      const form = new URLSearchParams(body);
      if (
        options.wrongPassword ||
        form.get('password') !== password ||
        form.get('_xsrf') !== '2|signed|fixture' ||
        form.get('next') !== '/prefix/'
      ) {
        response.end(`Invalid password ${password}`);
      } else {
        response.writeHead(302, {
          Location: options.redirect ?? '/prefix/',
          'Set-Cookie': `owned-session=${principal}; HttpOnly; Path=/prefix/`,
        });
        response.end();
      }
    } else if (!authenticated && !options.publicStatus) {
      response.writeHead(403);
      response.end('private error');
    } else if (path === '/prefix/api') {
      response.end(JSON.stringify({ version: '2.19.0' }));
    } else if (path === '/prefix/api/disclaude') {
      if (options.missing) {
        response.writeHead(404);
        response.end('missing');
      } else {
        response.end(
          JSON.stringify({
            protocolVersion: 1,
            serverNamespace: 'namespace',
            stack: {},
            activeRooms: 0,
            pendingRooms: 0,
            roomFailures: {},
            maxRooms: 16,
            idleSeconds: 60,
          })
        );
      }
    } else if (path === '/prefix/files/result.json') {
      const sameOrigin =
        request.headers.origin === `http://${request.headers.host}` &&
        request.headers.referer === `http://${request.headers.host}/prefix/`;
      response.writeHead(sameOrigin ? 200 : 403, { 'Content-Type': 'application/json' });
      response.end(sameOrigin ? '{"complete":true}' : '{"error":"cross origin"}');
    } else if (path.endsWith('/read-cell')) {
      response.end(
        JSON.stringify({
          notebook,
          cellId: 'cell',
          source: 'print(1)',
          sourceHash: 'hash',
          revision: 'revision',
        })
      );
    } else if (path.endsWith('/submit')) {
      if (options.expireMutation) {
        principal = 'principal-2';
        response.writeHead(403);
        response.end('expired');
      } else if (request.headers['x-xsrftoken'] !== '2|signed|fixture') {
        response.writeHead(403);
        response.end('missing xsrf');
      } else {
        response.end(
          JSON.stringify({
            state: 'accepted',
            handle: { ...JSON.parse(body).target, requestId: 'request' },
          })
        );
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/`;
  nock.enableNetConnect((authority) => authority === new URL(baseUrl).host);
  const resolvePassword = vi.fn(() => Promise.resolve(password));
  const jar = await createJupyterCookieJar();
  const client = new JupyterCoordinatorClient({
    baseUrl,
    connectionId: 'host',
    password: resolvePassword,
    cookieJar: jar,
    timeoutMs: 1000,
  });
  return { client, baseUrl, seen, jar, resolvePassword };
}

describe('Jupyter password connection', () => {
  it('keeps authenticated file GET within the configured native origin policy', async () => {
    const f = await fixture();
    const response = await f.client.response('files/result.json');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ complete: true });
    const request = f.seen.find((item) => item.path === '/prefix/files/result.json');
    expect(request).toMatchObject({
      method: 'GET',
      origin: new URL(f.baseUrl).origin,
      referer: f.baseUrl,
    });
    expect(request?.body).not.toContain(password);
  });
  it('keeps fetch exceptions private and leaves a failed mutation unknown', async () => {
    const f = await fixture();
    await f.client.connect();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error(password)))
    );
    const result = await f.client.submit({
      target: {
        notebook,
        cellId: 'cell',
        expectedRevision: 'revision',
        sourceHash: 'hash',
        kernelId: 'kernel',
        kernelIncarnation: 'incarnation',
        runId: 'run',
        controller: { ownerId: 'owner', generation: 1 },
      },
      source: 'print(1)',
    });
    expect(result).toMatchObject({
      state: 'unknown',
      reason: 'Jupyter request outcome could not be verified',
    });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(f.seen.some((x) => x.path.endsWith('/submit'))).toBe(false);
  });

  it('coalesces standard password login and sends XSRF without putting credentials in Notebook bodies', async () => {
    const f = await fixture();
    await Promise.all([f.client.readCell(notebook, 'cell'), f.client.readCell(notebook, 'cell')]);
    expect(f.seen.filter((x) => x.method === 'POST' && x.path.endsWith('/login'))).toHaveLength(1);
    expect(f.resolvePassword).toHaveBeenCalledTimes(1);
    expect(f.seen.every((x) => x.authorization === undefined)).toBe(true);
    const result = await f.client.submit({
      target: {
        notebook,
        cellId: 'cell',
        expectedRevision: 'revision',
        sourceHash: 'hash',
        kernelId: 'kernel',
        kernelIncarnation: 'incarnation',
        runId: 'run',
        controller: { ownerId: 'owner', generation: 1 },
      },
      source: 'print(1)',
    });
    expect(result.state).toBe('accepted');
    expect(f.seen.at(-1)?.xsrf).toBe('2|signed|fixture');
    expect(
      f.seen
        .filter((x) => x.path.includes('/notebooks/'))
        .every((x) => !x.body.includes(password) && !x.body.includes('principal-1'))
    ).toBe(true);
  });

  it('restores a valid private cookie without resolving or sending the password again', async () => {
    const f = await fixture();
    await f.client.connect();
    const restored = await createJupyterCookieJar(await f.jar.serialize());
    const resolver = vi.fn(() => Promise.reject(new Error(password)));
    const next = new JupyterCoordinatorClient({
      baseUrl: f.baseUrl,
      connectionId: 'host',
      password: resolver,
      cookieJar: restored,
    });
    await next.readCell(notebook, 'cell');
    expect(resolver).not.toHaveBeenCalled();
    expect(f.seen.filter((x) => x.method === 'POST' && x.path.endsWith('/login'))).toHaveLength(1);
  });

  it('reports the missing coordinator independently of successful external authentication', async () => {
    const f = await fixture({ missing: true });
    expect(await f.client.inspectConnection()).toEqual({
      serverVersion: '2.19.0',
      coordinator: 'missing',
    });
    expect(f.seen.some((x) => x.path.includes('/notebooks/') || x.path.includes('/kernels'))).toBe(
      false
    );
    await expect(f.client.openNotebook('report.ipynb')).rejects.toThrow('extension is unavailable');
    expect(f.seen.some((x) => x.path.endsWith('/notebooks'))).toBe(false);
  });

  it.each(['https://foreign.example/login', '/outside/', 'http://user:secret@127.0.0.1/prefix/'])(
    'refuses login redirect %s without following it',
    async (redirect) => {
      const f = await fixture({ redirect });
      await expect(f.client.connect()).rejects.toThrow('redirect was refused');
      expect(f.seen.some((x) => x.path === '/prefix/api/disclaude')).toBe(false);
      expect(f.seen.filter((x) => x.method === 'POST')).toHaveLength(1);
    }
  );

  it('does not expose reflected password errors or a host resolver exception', async () => {
    const f = await fixture({ wrongPassword: true });
    await expect(f.client.connect()).rejects.toThrow('Jupyter password login failed');
    const other = new JupyterCoordinatorClient({
      baseUrl: f.baseUrl,
      connectionId: 'host',
      password: () => Promise.reject(new Error(password)),
    });
    await expect(other.connect()).rejects.toThrow(
      'Jupyter connection authentication is unavailable'
    );
  });

  it('refuses missing XSRF before resolving the password', async () => {
    const f = await fixture({ noXsrf: true });
    await expect(f.client.connect()).rejects.toThrow('login token is unavailable');
    expect(f.resolvePassword).not.toHaveBeenCalled();
    expect(f.seen.some((x) => x.method === 'POST')).toBe(false);
  });

  it('never retries an expired mutation; later safe reads reconnect separately', async () => {
    const f = await fixture({ expireMutation: true });
    const result = await f.client.submit({
      target: {
        notebook,
        cellId: 'cell',
        expectedRevision: 'revision',
        sourceHash: 'hash',
        kernelId: 'kernel',
        kernelIncarnation: 'incarnation',
        runId: 'run',
        controller: { ownerId: 'owner', generation: 1 },
      },
      source: 'print(1)',
    });
    expect(result.state).toBe('unknown');
    expect(f.seen.filter((x) => x.path.endsWith('/submit'))).toHaveLength(1);
    expect(f.seen.filter((x) => x.method === 'POST' && x.path.endsWith('/login'))).toHaveLength(1);
    await f.client.readCell(notebook, 'cell');
    expect(f.seen.filter((x) => x.path.endsWith('/submit'))).toHaveLength(1);
    expect(f.seen.filter((x) => x.method === 'POST' && x.path.endsWith('/login'))).toHaveLength(2);
  });

  it('requires exactly one secret mode and explicit host permission for non-loopback HTTP', () => {
    const settings = {
      baseUrl: 'http://192.0.2.10:8001',
      connectionId: 'host',
      password: () => Promise.resolve(password),
    };
    expect(() => new JupyterCoordinatorClient(settings)).toThrow('requires HTTPS');
    expect(
      () => new JupyterCoordinatorClient({ ...settings, allowInsecureHttp: true })
    ).not.toThrow();
    expect(
      () =>
        new JupyterCoordinatorClient({
          ...settings,
          allowInsecureHttp: true,
          authorization: () => Promise.resolve('token fixture'),
        })
    ).toThrow('exactly one');
    expect(
      () =>
        new JupyterCoordinatorClient({
          ...settings,
          allowInsecureHttp: true,
          baseUrl: 'http://user:secret@192.0.2.10',
        })
    ).toThrow('requires HTTPS');
    expect(
      () => new JupyterCoordinatorClient({ baseUrl: 'https://owned.example', connectionId: 'host' })
    ).toThrow('exactly one');
  });
});

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { JupyterCoordinatorClient, createJupyterCookieJar } from './coordinator-client.js';
import type { JupyterExecutionSubmitRequest, JupyterNotebookLocator } from './contracts.js';

const notebook: JupyterNotebookLocator = {
  identity: { connectionId: 'test', serverNamespace: 'namespace', documentId: 'document' },
  contentPath: 'folder/test.ipynb',
};
const controller = { ownerId: 'agent', generation: 1 };
const target = {
  notebook,
  cellId: 'cell',
  expectedRevision: 'revision',
  sourceHash: 'hash',
  kernelId: 'kernel',
  kernelIncarnation: 'incarnation',
  runId: 'run',
  controller,
};
const execution = { ...target, requestId: 'request' };
const submission: JupyterExecutionSubmitRequest = { target, source: 'print(1)' };
const observed = {
  notebook,
  cellId: 'cell',
  revision: 'revision',
  sourceHash: 'hash',
  source: 'print(1)',
};
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  nock.disableNetConnect();
});

async function fixture(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>
  ) => void,
  sessionCookies: string[] = []
) {
  const seen: Array<{
    path: string;
    authorization: string | undefined;
    cookie: string | undefined;
    body: Record<string, unknown>;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    seen.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      body,
    });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/prefix/api/disclaude') {
      if (sessionCookies.length) {
        response.setHeader('Set-Cookie', sessionCookies);
      }
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          serverNamespace: 'namespace',
          stack: { server: 'fixed' },
          activeRooms: 0,
          pendingRooms: 0,
          roomFailures: {},
          maxRooms: 16,
          idleSeconds: 60,
        })
      );
    } else {
      handler(request, response, body);
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
  const ownedAuthority = new URL(baseUrl).host;
  nock.enableNetConnect((authority) => authority === ownedAuthority);
  const client = new JupyterCoordinatorClient({
    baseUrl,
    connectionId: 'test',
    authorization: () => Promise.resolve('token fixture'),
    timeoutMs: 1000,
  });
  return { client, baseUrl, seen };
}

describe('JupyterCoordinatorClient', () => {
  it('reads bounded live overviews and restores a host cookie jar', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(
        JSON.stringify({
          notebook,
          cells: [{ cellId: 'markdown', cellType: 'markdown', sourcePreview: 'human revision' }],
        })
      )
    );
    expect(await client.describeNotebook(notebook)).toMatchObject({
      cells: [{ sourcePreview: 'human revision' }],
    });
    const original = await createJupyterCookieJar();
    await original.setCookie('host=private; Path=/', 'https://owned.example/');
    const restored = await createJupyterCookieJar(await original.serialize());
    expect(await restored.getCookieString('https://owned.example/')).toBe('host=private');
    expect(await restored.getCookieString('https://foreign.example/')).toBe('');
  });

  it('separates owner-stop acknowledgment from execution status', async () => {
    const { client, seen } = await fixture((request, response) =>
      response.end(
        JSON.stringify(
          request.url?.endsWith('/control-state')
            ? { controller, paused: true }
            : { state: 'requested', runIds: ['run'] }
        )
      )
    );
    expect(await client.controlState(notebook)).toEqual({ controller, paused: true });
    expect(await client.stopOwner(notebook, controller)).toEqual({
      state: 'requested',
      runIds: ['run'],
    });
    expect(seen.at(-1)?.body).toEqual({ notebook, controller });
    expect(seen.some((item) => item.path.endsWith('/status'))).toBe(false);
  });

  it('keeps malformed and failed owner-stop responses unknown', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ state: 'requested' }))
    );
    expect(await client.stopOwner(notebook, controller)).toMatchObject({ state: 'unknown' });
  });

  it('preserves the authenticated Jupyter cookie identity through control and edits', async () => {
    const { client, seen } = await fixture(
      (request, response) => {
        if (request.url?.endsWith('/control')) {
          response.end(JSON.stringify(controller));
        } else {
          response.end(
            JSON.stringify(
              request.headers.cookie === 'username-owned=session-1'
                ? { state: 'applied', snapshot: observed }
                : { state: 'ownership_lost', currentGeneration: 1 }
            )
          );
        }
      },
      ['username-owned=session-1; HttpOnly; Path=/prefix/']
    );
    expect(await client.claimControl(notebook, 'agent', 0)).toEqual(controller);
    expect(
      await client.editCellSource({
        notebook,
        cellId: 'cell',
        expectedRevision: 'revision',
        expectedSourceHash: 'hash',
        source: 'print(1)',
        controller,
      })
    ).toMatchObject({ state: 'applied' });
    expect(seen[0].cookie).toBeUndefined();
    expect(seen.slice(1).every((item) => item.cookie === 'username-owned=session-1')).toBe(true);
    expect(JSON.stringify(seen.map((item) => item.body))).not.toContain('session-1');
  });

  it('coalesces the initial handshake before concurrent Notebook requests', async () => {
    const { client, seen } = await fixture(
      (_request, response) => response.end(JSON.stringify(observed)),
      ['username-owned=session-1; HttpOnly; Path=/prefix/']
    );
    await Promise.all([client.readCell(notebook, 'cell'), client.readCell(notebook, 'cell')]);
    expect(seen.filter((item) => item.path === '/prefix/api/disclaude')).toHaveLength(1);
    expect(seen.slice(1).every((item) => item.cookie === 'username-owned=session-1')).toBe(true);
  });

  it('does not send cookies for foreign domains, paths or expired sessions', async () => {
    const { client, seen } = await fixture(
      (_request, response) => response.end(JSON.stringify(observed)),
      [
        'foreign=secret; Domain=example.com; Path=/',
        'outside=secret; Path=/other/',
        'expired=secret; Max-Age=0; Path=/',
        'username-owned=session-1; HttpOnly; Path=/prefix/',
      ]
    );
    await client.readCell(notebook, 'cell');
    expect(seen[1].cookie).toBe('username-owned=session-1');
  });

  it('keeps separate client cookie sessions on the same server', async () => {
    const { client, baseUrl, seen } = await fixture(
      (_request, response) => response.end(JSON.stringify(observed)),
      ['username-owned=session-1; HttpOnly; Path=/prefix/']
    );
    await client.readCell(notebook, 'cell');
    const other = new JupyterCoordinatorClient({
      baseUrl,
      connectionId: 'test',
      authorization: () => Promise.resolve('token fixture'),
    });
    await other.readCell(notebook, 'cell');
    expect(
      seen.filter((item) => item.path === '/prefix/api/disclaude').every((item) => !item.cookie)
    ).toBe(true);
  });

  it('keeps base prefixes and credentials outside the Notebook body', async () => {
    const { client, seen } = await fixture((_request, response) =>
      response.end(JSON.stringify(observed))
    );
    expect(await client.readCell(notebook, 'cell')).toEqual(observed);
    expect(seen.map((item) => item.path)).toEqual([
      '/prefix/api/disclaude',
      '/prefix/api/disclaude/notebooks/document/read-cell',
    ]);
    expect(seen.every((item) => item.authorization === 'token fixture')).toBe(true);
    expect(JSON.stringify(seen.map((item) => item.body))).not.toContain('token fixture');
  });

  it('rejects a cell from another namespace or document', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(
        JSON.stringify({
          ...observed,
          notebook: { ...notebook, identity: { ...notebook.identity, documentId: 'other' } },
        })
      )
    );
    await expect(client.readCell(notebook, 'cell')).rejects.toThrow('identity mismatch');
  });

  it('preserves edit conflicts and current controller generations', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ state: 'conflict', current: observed }))
    );
    expect(
      await client.editCellSource({
        notebook,
        cellId: 'cell',
        expectedRevision: 'old',
        expectedSourceHash: 'old',
        source: 'new',
        controller,
      })
    ).toEqual({ state: 'conflict', current: observed });
  });

  it('makes a lost edit response unknown without resending', async () => {
    const { client, seen } = await fixture((request) => request.socket.destroy());
    const result = await client.editCellSource({
      notebook,
      cellId: 'cell',
      expectedRevision: 'old',
      expectedSourceHash: 'old',
      source: 'new',
      controller,
    });
    expect(result.state).toBe('unknown');
    expect(seen.filter((item) => item.path.endsWith('edit-cell'))).toHaveLength(1);
  });

  it('checks the full accepted execution target', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(
        JSON.stringify({ state: 'accepted', handle: { ...execution, kernelIncarnation: 'wrong' } })
      )
    );
    expect((await client.submit(submission)).state).toBe('unknown');
  });

  it('reconciles a lost submission by the same runId without a second POST', async () => {
    const { client, seen } = await fixture((request, response) => {
      if (request.url?.endsWith('/submit')) {
        request.socket.destroy();
      } else {
        response.end(
          JSON.stringify({
            runId: 'run',
            state: 'completed',
            handle: execution,
            details: { persisted: true },
          })
        );
      }
    });
    expect(await client.submit(submission)).toMatchObject({ state: 'unknown', runId: 'run' });
    expect(await client.getStatus(notebook, 'run')).toMatchObject({
      state: 'completed',
      handle: execution,
      details: { persisted: true },
    });
    expect(seen.filter((item) => item.path.endsWith('/submit'))).toHaveLength(1);
  });

  it('never follows an execution redirect', async () => {
    const { client, seen } = await fixture((_request, response) => {
      response.writeHead(307, { Location: '/redirected' });
      response.end();
    });
    expect((await client.submit(submission)).state).toBe('unknown');
    expect(seen.some((item) => item.path === '/redirected')).toBe(false);
  });

  it('rejects a mismatched status runId', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ runId: 'other', state: 'completed', handle: execution }))
    );
    expect(await client.getStatus(notebook, 'run')).toMatchObject({
      state: 'unknown',
      runId: 'run',
    });
  });

  it('preserves stop acknowledgment separately from confirmation', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ state: 'requested' }))
    );
    expect(await client.stop(execution, controller)).toEqual({ state: 'requested' });
  });

  it('reports lost stop authority', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ state: 'ownership_lost', currentGeneration: 3 }))
    );
    expect(await client.stop(execution, controller)).toEqual({
      state: 'ownership_lost',
      currentGeneration: 3,
    });
  });

  it('pins a configured connection to its saved server namespace', async () => {
    const { baseUrl, seen } = await fixture((_request, response) => response.end('{}'));
    const client = new JupyterCoordinatorClient({
      baseUrl,
      connectionId: 'test',
      serverNamespace: 'old-server',
      authorization: () => Promise.resolve('token fixture'),
    });
    await expect(client.connect()).rejects.toThrow('another server namespace');
    expect(seen).toHaveLength(1);
  });

  it('fences one exact unaccepted target without sending any source code', async () => {
    const proof = { state: 'not_started', runId: target.runId, target, submissionFenced: true };
    const { client, seen } = await fixture((_request, response) =>
      response.end(JSON.stringify(proof))
    );
    expect(await client.reconcileSubmission(target)).toEqual(proof);
    const requests = seen.filter((item) => item.path.endsWith('/fence-submission'));
    expect(requests).toHaveLength(1);
    expect(requests[0].body).toEqual({ notebook, target });
    expect(requests[0].body).not.toHaveProperty('source');
  });

  it('observes an already recorded attempt without replacing or resubmitting it', async () => {
    const current = {
      runId: target.runId,
      state: 'unknown',
      handle: execution,
      reason: 'native send unknown',
    };
    const { client, seen } = await fixture((_request, response) =>
      response.end(JSON.stringify({ state: 'recorded', observation: current }))
    );
    expect(await client.reconcileSubmission(target)).toEqual({
      state: 'recorded',
      observation: current,
    });
    expect(seen.filter((item) => item.path.endsWith('/submit'))).toHaveLength(0);
  });

  it.each([
    { submissionFenced: false },
    { submissionFenced: 'true' },
    { target: { ...target, kernelIncarnation: 'other' } },
    { target: { ...target, sourceHash: 'other' } },
    { target: { ...target, controller: { ...controller, ownerId: 'foreign' } } },
    { runId: 'other' },
    { handle: execution },
  ])('keeps a malformed or foreign absence proof unknown (%j)', async (changed) => {
    const { client, seen } = await fixture((_request, response) =>
      response.end(
        JSON.stringify({
          state: 'not_started',
          runId: target.runId,
          target,
          submissionFenced: true,
          ...changed,
        })
      )
    );
    expect((await client.reconcileSubmission(target)).state).toBe('unknown');
    expect(seen.filter((item) => item.path.endsWith('/fence-submission'))).toHaveLength(1);
  });

  it('queries the original run after a lost fence reply without replaying the mutation', async () => {
    const proof = { state: 'not_started', runId: target.runId, target, submissionFenced: true };
    const { client, seen } = await fixture((request, response) => {
      if (request.url?.endsWith('/fence-submission')) {
        response.destroy();
      } else {
        response.end(JSON.stringify(proof));
      }
    });
    expect((await client.reconcileSubmission(target)).state).toBe('unknown');
    expect(await client.getStatus(notebook, target.runId)).toEqual(proof);
    expect(seen.filter((item) => item.path.endsWith('/fence-submission'))).toHaveLength(1);
    expect(seen.filter((item) => item.path.endsWith('/submit'))).toHaveLength(0);
  });

  it('does not infer an absence proof from not_started without a durable fence', async () => {
    const { client } = await fixture((_request, response) =>
      response.end(JSON.stringify({ runId: target.runId, state: 'not_started', target }))
    );
    expect((await client.getStatus(notebook, target.runId)).state).toBe('unknown');
  });

  it('keeps fence authorization or server failures unknown with one request', async () => {
    const { client, seen } = await fixture((_request, response) => {
      response.statusCode = 503;
      response.end('{}');
    });
    expect((await client.reconcileSubmission(target)).state).toBe('unknown');
    expect(seen.filter((item) => item.path.endsWith('/fence-submission'))).toHaveLength(1);
  });

  it('rejects another host connection before a mutating request', async () => {
    const { client, seen } = await fixture((_request, response) => response.end('{}'));
    const foreign = { ...notebook, identity: { ...notebook.identity, connectionId: 'foreign' } };
    await expect(client.readCell(foreign, 'cell')).rejects.toThrow('does not belong');
    expect(seen).toHaveLength(1);
  });

  it('bounds streamed response bodies', async () => {
    const { baseUrl } = await fixture((_request, response) =>
      response.end(JSON.stringify(observed))
    );
    const client = new JupyterCoordinatorClient({
      baseUrl,
      connectionId: 'test',
      serverNamespace: 'namespace',
      authorization: () => Promise.resolve('token fixture'),
      maxResponseBytes: 16,
    });
    await expect(client.readCell(notebook, 'cell')).rejects.toThrow('limit exceeded');
  });

  it.each([
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/?token=secret',
  ])('rejects unsafe connection URL %s', (baseUrl) => {
    expect(
      () =>
        new JupyterCoordinatorClient({
          baseUrl,
          connectionId: 'test',
          authorization: () => Promise.resolve('token fixture'),
        })
    ).toThrow();
  });
});

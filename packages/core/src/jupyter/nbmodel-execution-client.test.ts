import { describe, expect, it } from 'vitest';
import {
  JupyterNbmodelExecutionClient,
  type JupyterNbmodelConnection,
} from './nbmodel-execution-client.js';

interface MockStep {
  method: string;
  status: number;
  location?: string;
  body?: unknown;
}

interface MockCall {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

function createMockFetch(...steps: MockStep[]): {
  fetch: typeof fetch;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const step = steps.shift();
    if (!step) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'No mock response configured' }), { status: 500 })
      );
    }
    const headers = new Headers(init.headers);
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const responseHeaders = new Headers({
      ...(step.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(step.location === undefined ? {} : { Location: step.location }),
    });
    return Promise.resolve(
      new Response(step.body === undefined ? null : JSON.stringify(step.body), {
        status: step.status,
        headers: responseHeaders,
      })
    );
  };
  return { fetch, calls };
}

function connection(serverUrl = 'https://jupyter.example.test/team/'): JupyterNbmodelConnection {
  return { serverUrl, authorization: 'token test-only-secret' };
}

const target = {
  documentPath: 'research/analysis.ipynb',
  cellId: 'cell-1',
  documentId: 'json:notebook:550e8400-e29b-41d4-a716-446655440000',
};

describe('JupyterNbmodelExecutionClient', () => {
  it('submits one cell-bound request with authorization in a header and polls its outputs', async () => {
    const mock = createMockFetch(
      {
        method: 'POST',
        status: 202,
        location: '/team/api/kernels/kernel-1/requests/request-1',
      },
      { method: 'GET', status: 202, body: { request_status: 'running', outputs: '[]' } },
      {
        method: 'GET',
        status: 200,
        body: {
          request_id: 'request-1',
          kernel_id: 'kernel-1',
          cell_id: target.cellId,
          document_path: target.documentPath,
          request_status: 'complete',
          execution: {
            status: 'ok',
            execution_count: 1,
            outputs: JSON.stringify([{ output_type: 'stream', text: '42\n' }]),
          },
        },
      }
    );
    const client = new JupyterNbmodelExecutionClient(connection(), {
      fetch: mock.fetch,
      pollIntervalMs: 1,
      maxWaitMs: 1_000,
    });

    const result = await client.execute('kernel-1', 'print(42)', target);

    expect(result).toMatchObject({
      state: 'completed',
      handle: { kernelId: 'kernel-1', requestId: 'request-1', target },
      executionCount: 1,
      outputs: [{ output_type: 'stream', text: '42\n' }],
    });
    expect(mock.calls).toHaveLength(3);
    expect(mock.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'GET']);
    expect(mock.calls[0]).toMatchObject({
      url: 'https://jupyter.example.test/team/api/kernels/kernel-1/execute',
      method: 'POST',
      body: JSON.stringify({
        code: 'print(42)',
        metadata: {
          document_path: target.documentPath,
          cell_id: target.cellId,
          document_id: target.documentId,
        },
      }),
    });
    expect(mock.calls[0].headers.get('authorization')).toBe('token test-only-secret');
    expect(mock.calls[0].url).not.toContain('test-only-secret');
  });

  it('confirms cancellation by observing KeyboardInterrupt after DELETE returns 204', async () => {
    const mock = createMockFetch(
      {
        method: 'POST',
        status: 202,
        location: '/team/api/kernels/kernel-1/requests/request-2',
      },
      { method: 'GET', status: 202, body: { request_status: 'running', outputs: '[]' } },
      { method: 'DELETE', status: 204 },
      {
        method: 'GET',
        status: 500,
        body: {
          request_id: 'request-2',
          kernel_id: 'kernel-1',
          cell_id: target.cellId,
          document_path: target.documentPath,
          request_status: 'complete',
          execution: {
            status: 'error',
            execution_count: 2,
            outputs: JSON.stringify([
              { output_type: 'stream', name: 'stdout', text: 'started\n' },
              { output_type: 'error', ename: 'KeyboardInterrupt', evalue: '', traceback: [] },
            ]),
          },
        },
      }
    );
    const client = new JupyterNbmodelExecutionClient(connection(), {
      fetch: mock.fetch,
      pollIntervalMs: 20,
      maxWaitMs: 1_000,
    });
    const submitted = await client.submit('kernel-1', 'long_running_cell()', target);
    expect(submitted.state).toBe('accepted');
    if (submitted.state !== 'accepted') {
      throw new Error('Expected the test execution to be accepted');
    }
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 5);

    const result = await client.waitForCompletion(submitted.handle, { signal: abort.signal });

    expect(result).toMatchObject({
      state: 'cancelled',
      handle: submitted.handle,
      outputs: [{ output_type: 'stream' }, { output_type: 'error', ename: 'KeyboardInterrupt' }],
    });
    expect(mock.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'DELETE', 'GET']);
  });

  it('returns unknown rather than replaying when the accepted request URL is unsafe', async () => {
    const mock = createMockFetch({
      method: 'POST',
      status: 202,
      location: 'https://attacker.invalid/api/kernels/kernel-1/requests/request-3',
    });
    const client = new JupyterNbmodelExecutionClient(connection(), { fetch: mock.fetch });

    const result = await client.submit('kernel-1', 'print(1)', target);

    expect(result).toEqual({
      state: 'unknown',
      reason: 'accepted_request_missing_safe_location',
      httpStatus: 202,
    });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe('POST');
  });

  it('does not replay after an ambiguous server failure and distinguishes an expired request', async () => {
    const mock = createMockFetch(
      { method: 'POST', status: 503, body: { message: 'temporary failure' } },
      { method: 'GET', status: 404, body: { message: 'request is no longer available' } }
    );
    const client = new JupyterNbmodelExecutionClient(connection(), { fetch: mock.fetch });

    const submission = await client.submit('kernel-1', 'print(1)', target);
    const expired = await client.getStatus({
      kernelId: 'kernel-1',
      requestId: 'old-request',
      target,
    });

    expect(submission).toEqual({
      state: 'unknown',
      reason: 'unexpected_submit_status',
      httpStatus: 503,
    });
    expect(expired).toEqual({
      state: 'unknown',
      handle: { kernelId: 'kernel-1', requestId: 'old-request', target },
      reason: 'server_no_longer_has_request',
      httpStatus: 404,
    });
    expect(mock.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(mock.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
  });

  it('does not equate an outer complete marker with a successful cell execution', async () => {
    const mock = createMockFetch(
      {
        method: 'POST',
        status: 202,
        location: '/team/api/kernels/kernel-1/requests/request-4',
      },
      { method: 'GET', status: 200, body: { request_status: 'complete' } }
    );
    const client = new JupyterNbmodelExecutionClient(connection(), { fetch: mock.fetch });
    const submitted = await client.submit('kernel-1', 'print(1)', target);
    expect(submitted.state).toBe('accepted');
    if (submitted.state !== 'accepted') {
      throw new Error('Expected the test execution to be accepted');
    }

    const observation = await client.getStatus(submitted.handle);

    expect(observation).toMatchObject({
      state: 'unknown',
      reason: 'completed_without_execution_result',
      httpStatus: 200,
    });
  });

  it('rejects insecure remote URLs and user info', () => {
    expect(
      () =>
        new JupyterNbmodelExecutionClient(connection('http://192.0.2.4/team/'), {
          fetch: createMockFetch().fetch,
        })
    ).toThrow(/requires HTTPS/);
    expect(
      () =>
        new JupyterNbmodelExecutionClient(connection('https://user:pass@example.com/'), {
          fetch: createMockFetch().fetch,
        })
    ).toThrow(/credentials/);
  });

  it('rejects unsafe Jupyter collaboration room identifiers', async () => {
    const client = new JupyterNbmodelExecutionClient(connection(), {
      fetch: createMockFetch().fetch,
    });

    await expect(
      client.submit('kernel-1', 'print(1)', {
        ...target,
        documentId: 'json:notebook:../outside',
      })
    ).rejects.toThrow(/documentId/);
  });

  it('keeps a result unknown if the server reports a different cell identity', async () => {
    const mock = createMockFetch({
      method: 'GET',
      status: 200,
      body: {
        request_id: 'request-5',
        kernel_id: 'kernel-1',
        cell_id: 'another-cell',
        document_path: target.documentPath,
        request_status: 'complete',
        status: 'ok',
        outputs: '[]',
      },
    });
    const client = new JupyterNbmodelExecutionClient(connection(), { fetch: mock.fetch });

    const result = await client.getStatus({ kernelId: 'kernel-1', requestId: 'request-5', target });

    expect(result).toMatchObject({ state: 'unknown', reason: 'cell_identity_mismatch' });
  });
});

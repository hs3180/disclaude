import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import { DatalayerJupyterClient } from './datalayer-client.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  nock.disableNetConnect();
});

async function fixture(
  reply: (
    path: string,
    method: string,
    body: Record<string, unknown>
  ) => { status?: number; headers?: Record<string, string>; data?: unknown; raw?: string }
) {
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks).toString();
    const body = bytes ? (JSON.parse(bytes) as Record<string, unknown>) : {};
    const row = { path: request.url!, method: request.method!, body };
    requests.push(row);
    const result = reply(row.path, row.method, body);
    response.writeHead(result.status ?? 200, {
      'content-type': 'application/json',
      ...result.headers,
    });
    response.end(result.raw ?? JSON.stringify(result.data ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/`;
  nock.enableNetConnect((authority) => authority === new URL(baseUrl).host);
  const client = new DatalayerJupyterClient({
    baseUrl,
    authorization: () => Promise.resolve('token fixture'),
  });
  return { client, requests, baseUrl };
}

function discoveryReply(path: string, _method: string, body: Record<string, unknown>) {
  if (path === '/prefix/api') {
    return { data: { version: '2.21.1' } };
  }
  if (path === '/prefix/mcp') {
    return {
      data: {
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
            : { tools: [{ name: 'read_cell', inputSchema: { type: 'object' } }] },
      },
    };
  }
  if (path === '/prefix/lab') {
    return {
      raw: `<script type="application/json" id="jupyter-config-data">${JSON.stringify({
        disableRTC: false,
        serverSideExecution: true,
        token: 'private-page-value',
      })}</script>`,
    };
  }
  if (path === '/prefix/api/nbconvert') {
    return { data: { html: {}, notebook: {} } };
  }
  const queue = path.match(/^\/prefix\/api\/kernels\/([^/]+)\/execute$/);
  if (queue) {
    return { data: { kernel_id: queue[1], requests: [] } };
  }
  return { status: 404 };
}

function queuePolicy(serverInstanceId = 'server-instance') {
  return {
    kernel_id: 'kernel',
    requests: [],
    execution_policy: {
      schema: 1,
      server_instance_id: serverInstanceId,
      terminal_gets: 'non_consuming',
      result_retention_seconds: 3600,
      request_quota: 512,
      inline_result_bytes: 65536,
      target_cancellation: 'managed_pid_and_queue_owner',
      native_incarnation: true,
      source_provenance: true,
      stdin_opt_out: true,
    },
  };
}

describe('existing Datalayer HTTP interfaces', () => {
  it('accepts complete inline report bodies above the historical 3 MB limit', async () => {
    const html = `<html>${'x'.repeat(4_000_000)}</html>`;
    const f = await fixture(() => ({ raw: html, headers: { 'content-type': 'text/html' } }));
    const response = await f.client.response('nbconvert/html', 'POST', { name: 'report.ipynb' });
    expect(await f.client.responseText(response)).toBe(html);
    expect(f.requests).toHaveLength(1);
  });

  it('still bounds complete reports and honors a host-provided smaller limit', async () => {
    const f = await fixture(() => ({ raw: 'x'.repeat(8_000_001) }));
    await expect(
      f.client.responseText(await f.client.response('files/report.html'))
    ).rejects.toThrow('limit exceeded');
    const limited = new DatalayerJupyterClient({
      baseUrl: f.baseUrl,
      authorization: () => Promise.resolve('token fixture'),
      maxResponseBytes: 16,
    });
    await expect(limited.responseText(await limited.response('files/report.html'))).rejects.toThrow(
      'limit exceeded'
    );
  });

  it('resolves the original file ID through the native read-only reverse path route', async () => {
    const f = await fixture(() => ({ data: { id: 'document', path: 'renamed.ipynb' } }));
    expect(await f.client.documentPath('document')).toBe('renamed.ipynb');
    expect(f.requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/prefix/api/fileid/path?id=document'],
    ]);
  });

  it('refuses another file identity or a traversal path', async () => {
    const f = await fixture(() => ({ data: { id: 'copy', path: 'analysis.ipynb' } }));
    await expect(f.client.documentPath('original')).rejects.toThrow('stable path');
    const invalid = await fixture(() => ({ data: { id: 'document', path: '../outside.ipynb' } }));
    await expect(invalid.client.documentPath('document')).rejects.toThrow('without traversal');
    expect(invalid.requests).toHaveLength(1);
  });

  it('keeps complete result links on the configured origin and original artifact identity', async () => {
    const f = await fixture(() => ({
      data: {
        status: 'ok',
        outputs: '[]',
        outputs_truncated: true,
        result_artifact: 'nbmodel-results/kernel/request.json',
      },
    }));
    const observed = await f.client.observe({ kernelId: 'kernel', requestId: 'request' });
    expect(observed).toMatchObject({ state: 'completed', result: { outputs_truncated: true } });
    expect(new URL(String(observed.result?.original_result_entry)).pathname).toBe(
      '/prefix/api/kernels/kernel/requests/request'
    );
    const artifact = new URL(String(observed.result?.result_artifact_entry));
    expect(artifact.origin).toBe(new URL(String(observed.result?.original_result_entry)).origin);
    expect(artifact.pathname).toBe('/prefix/files/nbmodel-results/kernel/request.json');
    expect(artifact.search).toBe('');
  });

  it('does not expose a foreign artifact as the complete original result', async () => {
    const f = await fixture(() => ({
      data: {
        status: 'ok',
        outputs: '[]',
        outputs_truncated: true,
        result_artifact: '../unowned.json',
      },
    }));
    expect(await f.client.observe({ kernelId: 'kernel', requestId: 'request' })).toMatchObject({
      state: 'unknown',
    });
  });
  it('discovers native interfaces with safe requests and keeps product behavior unverified', async () => {
    const f = await fixture(discoveryReply);
    expect(await f.client.inspectConnection()).toEqual({
      backend: 'datalayer',
      serverVersion: '2.21.1',
      mcp: { state: 'available', protocolVersion: '2024-11-05', tools: ['read_cell'] },
      nbmodel: { state: 'available', httpStatus: 200 },
      rtc: { state: 'configured', httpStatus: 200, serverSideExecution: true },
      nbconvert: { state: 'available', httpStatus: 200, formats: ['html', 'notebook'] },
      productAcceptance: 'not_verified',
    });
    expect(
      f.requests.every(
        (r) =>
          r.method === 'GET' ||
          (r.path === '/prefix/mcp' && ['initialize', 'tools/list'].includes(String(r.body.method)))
      )
    ).toBe(true);
    expect(f.requests.some((r) => r.path.includes('/api/disclaude'))).toBe(false);
  });

  it('reports missing Datalayer handlers separately from authenticated Jupyter', async () => {
    const f = await fixture((p, m, b) =>
      p === '/prefix/mcp' || p.endsWith('/execute') ? { status: 404 } : discoveryReply(p, m, b)
    );
    expect(await f.client.inspectConnection()).toMatchObject({
      serverVersion: '2.21.1',
      mcp: { state: 'missing', httpStatus: 404 },
      nbmodel: { state: 'missing', httpStatus: 404 },
      nbconvert: { state: 'available' },
      productAcceptance: 'not_verified',
    });
  });

  it('refuses an incompatible tool schema without calling any tool', async () => {
    const f = await fixture((p, m, b) =>
      b.method === 'tools/list'
        ? {
            data: {
              jsonrpc: '2.0',
              id: b.id,
              result: { tools: [{ name: 'read_cell', inputSchema: [] }] },
            },
          }
        : discoveryReply(p, m, b)
    );
    expect(await f.client.inspectConnection()).toMatchObject({ mcp: { state: 'incompatible' } });
    expect(f.requests.some((r) => r.body.method === 'tools/call')).toBe(false);
  });

  it('does not expose reflected credentials in remote JSON-RPC failures', async () => {
    const f = await fixture((_p, _m, b) => ({
      data: {
        jsonrpc: '2.0',
        id: b.id,
        error: { code: -32000, message: 'token reflected-private-value' },
      },
    }));
    await expect(f.client.listTools()).rejects.toThrow('code -32000');
    await expect(f.client.listTools()).rejects.not.toThrow('reflected-private-value');
  });

  it('stops discovery at an invalid server version without exposing its content', async () => {
    const f = await fixture(() => ({ data: { version: 'reflected-private-value' } }));
    await expect(f.client.inspectConnection()).rejects.toThrow('could not be verified');
    expect(f.requests).toHaveLength(1);
  });

  it('calls the actual JSON-RPC endpoint instead of the REST placeholder', async () => {
    const f = await fixture((_path, _method, body) => ({
      data: {
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: 'actual notebook data' }] },
      },
    }));
    const result = await f.client.callTool('read_notebook', { notebook_name: 'owned' });
    expect(result.content).toEqual([{ type: 'text', text: 'actual notebook data' }]);
    expect(f.requests).toEqual([
      {
        path: '/prefix/mcp',
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'read_notebook', arguments: { notebook_name: 'owned' } },
        },
      },
    ]);
  });

  it('does not accept an unrelated JSON-RPC response', async () => {
    const f = await fixture(() => ({ data: { jsonrpc: '2.0', id: 987, result: {} } }));
    await expect(f.client.initialize()).rejects.toThrow('identity mismatch');
  });

  it('keeps an accepted request with a missing handle unknown without retrying', async () => {
    const f = await fixture(() => ({ status: 202 }));
    expect(await f.client.submitCell('kernel', 'document', 'cell', 'print(1)')).toEqual({
      state: 'unknown',
      httpStatus: 202,
    });
    expect(f.requests).toHaveLength(1);
  });

  it('rejects a foreign request Location without contacting it', async () => {
    const f = await fixture(() => ({
      status: 202,
      headers: { Location: 'https://foreign.invalid/api/kernels/kernel/requests/request' },
    }));
    expect(await f.client.submitCell('kernel', 'document', 'cell', 'print(1)')).toEqual({
      state: 'unknown',
      httpStatus: 202,
    });
    expect(f.requests).toHaveLength(1);
  });

  it('parses the nbmodel handle and confirms KeyboardInterrupt only from its result', async () => {
    const f = await fixture((_path, method) =>
      method === 'POST'
        ? { status: 202, headers: { Location: '/prefix/api/kernels/kernel/requests/request' } }
        : { status: 500, data: { error: { ename: 'KeyboardInterrupt', evalue: '' }, outputs: [] } }
    );
    const result = await f.client.submitCell('kernel', 'document', 'cell', 'print(1)');
    expect(result).toEqual({
      state: 'accepted',
      handle: { kernelId: 'kernel', requestId: 'request' },
    });
    expect(await f.client.observe({ kernelId: 'kernel', requestId: 'request' })).toMatchObject({
      state: 'cancelled',
      httpStatus: 500,
    });
  });

  it('does not accept a request handle from another application on the same server', async () => {
    const f = await fixture(() => ({
      status: 202,
      headers: { Location: '/other/api/kernels/kernel/requests/request' },
    }));
    expect(await f.client.submitCell('kernel', 'document', 'cell', 'print(1)')).toEqual({
      state: 'unknown',
      httpStatus: 202,
    });
    expect(f.requests).toHaveLength(1);
  });

  it('does not interrupt a shared kernel when request cancellation is absent', async () => {
    const f = await fixture(() => ({ status: 405 }));
    expect(await f.client.stopRequest({ kernelId: 'kernel', requestId: 'request' })).toBe(
      'unsupported'
    );
    expect(f.requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/prefix/api/kernels/kernel/execute'],
    ]);
  });

  it('refuses a legacy DELETE handler without a target cancellation policy', async () => {
    const f = await fixture((_path, method) =>
      method === 'DELETE' ? { status: 204 } : { data: { kernel_id: 'kernel', requests: [] } }
    );
    expect(await f.client.stopRequest({ kernelId: 'kernel', requestId: 'request' })).toBe(
      'unsupported'
    );
    expect(f.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('checks the original server instance before stopping a recovered request', async () => {
    const f = await fixture(() => ({ data: queuePolicy('replacement-server') }));
    expect(
      await f.client.stopRequest({
        kernelId: 'kernel',
        requestId: 'request',
        serverInstanceId: 'original-server',
      })
    ).toBe('unknown');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].method).toBe('GET');
  });

  it('uses only the target DELETE when the queue policy is compatible', async () => {
    const f = await fixture((_path, method) =>
      method === 'DELETE' ? { status: 204 } : { data: queuePolicy() }
    );
    expect(
      await f.client.stopRequest({
        kernelId: 'kernel',
        requestId: 'request',
        serverInstanceId: 'server-instance',
      })
    ).toBe('requested');
    expect(f.requests.map((r) => [r.method, r.path])).toEqual([
      ['GET', '/prefix/api/kernels/kernel/execute'],
      ['DELETE', '/prefix/api/kernels/kernel/requests/request'],
    ]);
  });

  it('retains queued cancellation and bounded running status explicitly', async () => {
    const f = await fixture(() => ({
      status: 500,
      data: { error: { ename: 'CancelledError' }, execution_started: false, outputs: '[]' },
    }));
    expect(await f.client.observe({ kernelId: 'kernel', requestId: 'request' })).toMatchObject({
      state: 'cancelled',
      result: { execution_started: false },
    });
    const running = await fixture(() => ({
      status: 202,
      data: { pending: true, outputs_truncated: true, result_artifact_pending: true },
    }));
    expect(
      await running.client.observe({ kernelId: 'kernel', requestId: 'request' })
    ).toMatchObject({
      state: 'running',
      result: { outputs_truncated: true, result_artifact_pending: true },
    });
  });

  it('rejects a result carrying another original native incarnation', async () => {
    const f = await fixture(() => ({
      data: {
        status: 'ok',
        request_id: 'request',
        kernel_id: 'kernel',
        kernel_incarnation: 'replacement',
        outputs: '[]',
      },
    }));
    expect(
      await f.client.observe({
        kernelId: 'kernel',
        requestId: 'request',
        kernelIncarnation: 'original',
      })
    ).toMatchObject({ state: 'unknown' });
  });

  it('records recoverable Location and sends explicit original context with stdin disabled', async () => {
    const f = await fixture(() => ({
      status: 202,
      headers: { Location: '/prefix/api/kernels/kernel/requests/request' },
    }));
    const result = await f.client.submitCell('kernel', 'document', 'cell', 'print(1)', {
      documentPath: 'owned.ipynb',
      runId: 'original-run',
      kernelIncarnation: 'native-instance',
      serverInstanceId: 'server-instance',
    });
    expect(result).toMatchObject({
      state: 'accepted',
      handle: {
        requestLocation: '/prefix/api/kernels/kernel/requests/request',
        kernelIncarnation: 'native-instance',
        serverInstanceId: 'server-instance',
      },
    });
    expect(f.requests[0].body.metadata).toMatchObject({
      document_path: 'owned.ipynb',
      run_id: 'original-run',
      kernel_incarnation: 'native-instance',
      allow_stdin: false,
    });
  });

  it('handles installed 0.1.1a4 string outputs and HTTP 200 Python errors', async () => {
    const f = await fixture(() => ({
      data: {
        status: 'error',
        execution_count: 5,
        outputs: JSON.stringify([{ output_type: 'error', ename: 'KeyboardInterrupt', evalue: '' }]),
      },
    }));
    const observed = await f.client.observe({ kernelId: 'kernel', requestId: 'original' });
    expect(observed.state).toBe('cancelled');
    expect(observed.result?.outputs).toEqual([
      { output_type: 'error', ename: 'KeyboardInterrupt', evalue: '' },
    ]);
  });

  it('keeps authorization inside the configured server prefix', async () => {
    const f = await fixture(() => ({}));
    await expect(f.client.response('../foreign')).rejects.toThrow('escaped the configured server');
    expect(f.requests).toEqual([]);
  });
});

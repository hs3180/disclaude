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
  ) => { status?: number; headers?: Record<string, string>; data?: unknown }
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
    response.end(JSON.stringify(result.data ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/`;
  nock.enableNetConnect((authority) => authority === new URL(baseUrl).host);
  const client = new DatalayerJupyterClient({
    baseUrl,
    authorization: () => Promise.resolve('token fixture'),
  });
  return { client, requests };
}

describe('existing Datalayer HTTP interfaces', () => {
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
      ['DELETE', '/prefix/api/kernels/kernel/requests/request'],
    ]);
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

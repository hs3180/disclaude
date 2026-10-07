import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { YNotebook } from '@jupyter/ydoc';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as sync from 'y-protocols/sync';
import { WebSocketServer } from 'ws';
import nock from 'nock';
import { expect, it } from 'vitest';
import { DatalayerJupyterClient } from './datalayer-client.js';

it('uses the literal Jupyter room ID and reads independent unsaved Yjs changes', async () => {
  const serverNotebook = new YNotebook();
  serverNotebook.fromJSON({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'code',
        cell_type: 'code',
        metadata: {},
        source: 'value = 1',
        execution_count: null,
        outputs: [],
      },
    ],
  });
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url!);
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        format: 'json',
        type: 'notebook',
        fileId: 'file-id',
        sessionId: 'session-id',
      })
    );
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    paths.push(request.url!);
    if (
      request.url !== '/prefix/api/collaboration/room/json:notebook:file-id?sessionId=session-id'
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      sockets.emit('connection', ws);
      ws.on('message', (raw) => {
        const decoder = decoding.createDecoder(new Uint8Array(raw as Buffer));
        if (decoding.readVarUint(decoder) !== 0) {
          return;
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        sync.readSyncMessage(decoder, encoder, serverNotebook.ydoc, ws);
        if (encoding.length(encoder) > 1) {
          ws.send(encoding.toUint8Array(encoder));
        }
      });
    });
  });
  serverNotebook.ydoc.on('update', (update: Uint8Array) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    sync.writeUpdate(encoder, update);
    for (const socket of sockets.clients) {
      socket.send(encoding.toUint8Array(encoder));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/prefix/`;
  nock.enableNetConnect((authority) => authority === new URL(baseUrl).host);
  const client = new DatalayerJupyterClient({
    baseUrl,
    authorization: () => Promise.resolve('token fixture'),
  });
  let document: Awaited<ReturnType<DatalayerJupyterClient['openDocument']>> | undefined;
  try {
    document = await client.openDocument('analysis.ipynb');
    expect(document.snapshot().cells[0].source).toBe('value = 1');
    serverNotebook.getCell(0).source = 'value = 17';
    await document.flush();
    expect(document.snapshot().cells[0].source).toBe('value = 17');
    expect(paths).toContain(
      '/prefix/api/collaboration/room/json:notebook:file-id?sessionId=session-id'
    );
  } finally {
    document?.close();
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    serverNotebook.dispose();
    nock.disableNetConnect();
  }
});

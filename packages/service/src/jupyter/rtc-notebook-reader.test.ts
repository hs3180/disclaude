import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { YNotebook } from '@jupyter/ydoc';
import nock from 'nock';
import * as syncProtocol from 'y-protocols/sync';
import { WebSocketServer, type RawData } from 'ws';
import { readJupyterSharedNotebookCell } from './rtc-notebook-reader.js';

describe('readJupyterSharedNotebookCell', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects invalid paths before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token' },
        '../private.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('relative .ipynb path');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects credentials or token query parameters in the server URL', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://user:password@jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('must not contain credentials');
    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/?token=secret', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('must not contain credentials');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires HTTPS for authenticated non-loopback servers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'http://jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('requires HTTPS');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed authorization headers and cell identifiers', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token\nX-Leak: value' },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('authorization header');
    await expect(
      readJupyterSharedNotebookCell(
        { serverUrl: 'https://jupyter.example/', authorization: 'token test-token' },
        'analysis.ipynb',
        ''
      )
    ).rejects.toThrow('cellId is required');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid timeouts before making a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      readJupyterSharedNotebookCell(
        {
          serverUrl: 'https://jupyter.example/',
          authorization: 'token test-token',
          timeoutMs: 120_001,
        },
        'analysis.ipynb',
        'cell-1'
      )
    ).rejects.toThrow('timeoutMs');

    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads a cell from the live Y document over the collaboration session and WebSocket APIs', async () => {
    const sharedNotebook = new YNotebook();
    const expectedCell = sharedNotebook.addCell({
      cell_type: 'code',
      source: 'print("unsaved edit")',
    });
    const expectedSource = 'print("unsaved edit")';
    const expectedCellId = expectedCell.id;
    const expectedSourceHash = createHash('sha256').update(expectedSource, 'utf8').digest('hex');
    const server = createServer((request, response) => {
      if (
        request.method !== 'PUT' ||
        request.url !== '/base/api/collaboration/session/research/analysis%20final.ipynb'
      ) {
        response.writeHead(404).end();
        return;
      }
      expect(request.headers.authorization).toBe('token test-token');
      let requestBody = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (requestBody += chunk));
      request.on('end', () => {
        expect(JSON.parse(requestBody)).toEqual({ format: 'json', type: 'notebook' });
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
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    let clientSyncMessages = 0;
    server.on('upgrade', (request, socket, head) => {
      if (
        request.url !== '/base/api/collaboration/room/json:notebook:file-id?sessionId=session-id'
      ) {
        socket.destroy();
        return;
      }
      expect(request.headers.authorization).toBe('token test-token');
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    webSocketServer.on('connection', (webSocket) => {
      webSocket.on('message', (rawData) => {
        clientSyncMessages += 1;
        const decoder = decoding.createDecoder(toUint8Array(rawData));
        expect(decoding.readVarUint(decoder)).toBe(0);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, 0);
        const syncMessage = syncProtocol.readSyncMessage(
          decoder,
          encoder,
          sharedNotebook.ydoc,
          webSocket
        );
        expect(syncMessage).toBe(syncProtocol.messageYjsSyncStep1);
        webSocket.send(encoding.toUint8Array(encoder));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const isTestServerHost = (host: string): boolean => host === `127.0.0.1:${address.port}`;
    nock.enableNetConnect(isTestServerHost);

    try {
      const snapshot = await readJupyterSharedNotebookCell(
        {
          serverUrl: `http://127.0.0.1:${address.port}/base/`,
          authorization: 'token test-token',
          timeoutMs: 2_000,
        },
        'research/analysis final.ipynb',
        expectedCellId
      );

      expect(snapshot).toMatchObject({
        connectionServerUrl: `http://127.0.0.1:${address.port}/base/`,
        contentPath: 'research/analysis final.ipynb',
        documentId: 'file-id',
        cellId: expectedCellId,
        cellIndex: 0,
        cellType: 'code',
        source: expectedSource,
        sourceHash: expectedSourceHash,
      });
      expect(snapshot.revision).toMatch(/^[a-f\d]{64}$/);
      expect(clientSyncMessages).toBe(1);
      expect((sharedNotebook.getCell(0).toJSON() as { source: string }).source).toBe(
        expectedSource
      );
    } finally {
      sharedNotebook.dispose();
      sharedNotebook.ydoc.destroy();
      await closeServer(server, webSocketServer);
      nock.disableNetConnect();
      nock.enableNetConnect('127.0.0.1');
      nock.enableNetConnect('localhost');
    }
  });
});

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const buffer = Buffer.concat(data);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new Error('Unexpected WebSocket test frame type');
}

async function closeServer(server: Server, webSocketServer: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    webSocketServer.close((webSocketError) => {
      if (webSocketError) {
        reject(webSocketError);
        return;
      }
      server.close((serverError) => (serverError ? reject(serverError) : resolve()));
    });
  });
}

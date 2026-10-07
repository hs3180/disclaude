import { createHash } from 'node:crypto';
import { YNotebook } from '@jupyter/ydoc';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as sync from 'y-protocols/sync';
import { encodeStateVector } from 'yjs';
import WebSocket from 'ws';
import type { DatalayerJupyterClient } from './datalayer-client.js';

export function notebookPath(path: string): string {
  if (
    !path ||
    path.length > 1024 ||
    !path.endsWith('.ipynb') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error('Notebook requires a relative .ipynb path without traversal');
  }
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Native Jupyter collaboration client, using the official YNotebook model. */
export class JupyterRtcDocument {
  readonly notebook = new YNotebook();
  private socket?: WebSocket;
  private closed = false;
  private disposed = false;
  private synced = false;
  private syncReply?: { resolve(): void; reject(error: Error): void };

  private constructor(
    readonly documentId: string,
    readonly contentPath: string
  ) {}

  static async open(
    client: DatalayerJupyterClient,
    path: string,
    expectedId?: string
  ): Promise<JupyterRtcDocument> {
    const session = (await client.json(`api/collaboration/session/${notebookPath(path)}`, 'PUT', {
      format: 'json',
      type: 'notebook',
    })) as Record<string, unknown>;
    if (
      session.format !== 'json' ||
      session.type !== 'notebook' ||
      typeof session.fileId !== 'string' ||
      typeof session.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(session.fileId) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(session.sessionId)
    ) {
      throw new Error('Invalid Jupyter collaboration session');
    }
    if (expectedId && expectedId !== session.fileId) {
      throw new Error('Notebook document identity changed');
    }
    const doc = new JupyterRtcDocument(session.fileId, path);
    const options = await client.socket(
      `api/collaboration/room/json:notebook:${session.fileId}?sessionId=${encodeURIComponent(session.sessionId)}`
    );
    const socket = new WebSocket(options.url, {
      headers: options.headers,
      followRedirects: false,
      handshakeTimeout: 15000,
      maxPayload: 8 * 1024 * 1024,
    });
    doc.socket = socket;
    socket.on('error', () => doc.fail('Jupyter collaboration connection failed'));
    socket.on('close', () => doc.fail('Jupyter collaboration connection closed'));
    socket.on('message', (data) => {
      try {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : data;
        const decoder = decoding.createDecoder(bytes);
        const type = decoding.readVarUint(decoder);
        if (type === 2) {
          doc.fail('Jupyter collaboration authorization failed');
          return;
        }
        if (type !== 0) {
          return;
        }
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, 0);
        const kind = sync.readSyncMessage(decoder, reply, doc.notebook.ydoc, socket);
        if (encoding.length(reply) > 1 && socket.readyState === WebSocket.OPEN) {
          socket.send(encoding.toUint8Array(reply));
        }
        if (kind === sync.messageYjsSyncStep2) {
          doc.synced = true;
          const waiting = doc.syncReply;
          doc.syncReply = undefined;
          waiting?.resolve();
        }
      } catch {
        doc.fail('Jupyter collaboration sync failed');
      }
    });
    doc.notebook.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === socket || !doc.synced || doc.closed || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      sync.writeUpdate(encoder, update);
      socket.send(encoding.toUint8Array(encoder));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          doc.syncReply = undefined;
          reject(new Error('Jupyter collaboration initial sync timed out'));
        }, 15000);
        doc.syncReply = {
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        socket.once('open', () => doc.sendSync());
      });
      return doc;
    } catch (error) {
      doc.close();
      throw error;
    }
  }

  private sendSync(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    sync.writeSyncStep1(encoder, this.notebook.ydoc);
    this.socket?.send(encoding.toUint8Array(encoder));
  }

  private fail(message: string): void {
    this.closed = true;
    const waiting = this.syncReply;
    this.syncReply = undefined;
    waiting?.reject(new Error(message));
  }

  /** Ordered sync roundtrip confirms the server received preceding document updates. */
  async flush(): Promise<void> {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error('Jupyter collaboration connection is unavailable');
    }
    if (this.syncReply) {
      throw new Error('Jupyter collaboration sync is already pending');
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.syncReply = undefined;
        reject(new Error('Jupyter collaboration sync timed out'));
      }, 15000);
      this.syncReply = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.sendSync();
    });
  }

  snapshot(): {
    documentId: string;
    contentPath: string;
    revision: string;
    cells: Array<Record<string, unknown>>;
  } {
    if (this.closed) {
      throw new Error('Jupyter collaboration connection is unavailable');
    }
    return {
      documentId: this.documentId,
      contentPath: this.contentPath,
      revision: createHash('sha256').update(encodeStateVector(this.notebook.ydoc)).digest('hex'),
      cells: this.notebook.cells.map((c) => {
        const json = c.toJSON();
        return {
          ...json,
          source: c.source,
          sourceHash: createHash('sha256').update(c.source).digest('hex'),
        };
      }),
    };
  }

  close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.fail('Jupyter collaboration connection closed');
    this.socket?.close();
    this.notebook.dispose();
    this.notebook.ydoc.destroy();
  }
}

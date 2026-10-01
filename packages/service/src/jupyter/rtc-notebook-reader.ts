import { createHash } from 'node:crypto';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { YNotebook } from '@jupyter/ydoc';
import * as authProtocol from 'y-protocols/auth';
import * as syncProtocol from 'y-protocols/sync';
import WebSocket, { type RawData } from 'ws';
import { encodeStateVector, type Doc } from 'yjs';

export interface JupyterRtcConnection {
  /** Jupyter Server base URL, including any deployment prefix, and ending in `/`. */
  serverUrl: string;
  /** Jupyter authorization header value, for example `token …`. */
  authorization: string;
  /** Maximum time to obtain the collaborative document, in milliseconds. */
  timeoutMs?: number;
}

export interface JupyterSharedCellSnapshot {
  connectionServerUrl: string;
  contentPath: string;
  documentId: string;
  revision: string;
  cellId: string;
  cellIndex: number;
  cellType: string;
  source: string;
  sourceHash: string;
}

interface CollaborationSession {
  fileId: string;
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Read one cell from Jupyter's live Y document, including edits that have not
 * yet reached the Contents API. This client never writes document changes.
 */
export async function readJupyterSharedNotebookCell(
  connection: JupyterRtcConnection,
  contentPath: string,
  cellId: string
): Promise<JupyterSharedCellSnapshot> {
  const normalized = validateConnection(connection, contentPath, cellId);
  const timeoutMs = connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const session = await getCollaborationSession(normalized, contentPath, timeoutMs);
  const notebook = new YNotebook();
  let closeSocket: (() => void) | undefined;

  try {
    const room = `json:notebook:${session.fileId}`;
    const websocketBase = toWebSocketUrl(normalized.serverUrl, 'api/collaboration/room/');
    closeSocket = await connectAndSyncNotebook(
      websocketBase,
      room,
      session.sessionId,
      notebook.ydoc,
      normalized.authorization,
      timeoutMs
    );

    const cellIndex = notebook.cells.findIndex((cell) => cell.id === cellId);
    if (cellIndex < 0) {
      throw new Error(`Jupyter notebook cell not found: ${cellId}`);
    }

    const cell = notebook.getCell(cellIndex);
    const { id: syncedCellId, cell_type: cellType, source } = cell;
    const revision = createHash('sha256').update(encodeStateVector(notebook.ydoc)).digest('hex');
    const sourceHash = createHash('sha256').update(source, 'utf8').digest('hex');

    return {
      connectionServerUrl: normalized.serverUrl,
      contentPath,
      documentId: session.fileId,
      revision,
      cellId: syncedCellId,
      cellIndex,
      cellType,
      source,
      sourceHash,
    };
  } finally {
    closeSocket?.();
    notebook.dispose();
    notebook.ydoc.destroy();
  }
}

function connectAndSyncNotebook(
  websocketBase: string,
  room: string,
  sessionId: string,
  doc: Doc,
  authorization: string,
  timeoutMs: number
): Promise<() => void> {
  // A room name begins with `json:`, which URL treats as a scheme unless the
  // path-relative reference is explicitly rooted with `./`.
  const url = new URL(`./${room}`, websocketBase);
  url.searchParams.set('sessionId', sessionId);

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url.toString(), {
      handshakeTimeout: timeoutMs,
      headers: { Authorization: authorization },
      followRedirects: false,
    });
    let synced = false;
    let settled = false;

    const finishWithError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('open');
      socket.removeAllListeners('message');
      socket.removeAllListeners('close');
      socket.terminate();
      reject(error);
    };

    const timer = setTimeout(
      () =>
        finishWithError(
          new Error(`Timed out waiting for Jupyter collaboration sync after ${timeoutMs} ms`)
        ),
      timeoutMs
    );
    timer.unref?.();

    socket.once('open', () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, doc);
      socket.send(encoding.toUint8Array(encoder));
    });

    socket.on('message', (rawData: RawData) => {
      try {
        const decoder = decoding.createDecoder(toUint8Array(rawData));
        const messageType = decoding.readVarUint(decoder);
        if (messageType === 0) {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, 0);
          const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, socket);
          if (encoding.length(encoder) > 1) {
            socket.send(encoding.toUint8Array(encoder));
          }
          if (syncMessageType === syncProtocol.messageYjsSyncStep2 && !synced) {
            synced = true;
            settled = true;
            clearTimeout(timer);
            resolve(() => socket.close());
          }
        } else if (messageType === 2) {
          authProtocol.readAuthMessage(decoder, doc, () => {
            finishWithError(new Error('Jupyter collaboration authorization was rejected'));
          });
        }
        // Awareness is intentionally ignored: this client reads document state only.
      } catch {
        finishWithError(new Error('Jupyter collaboration document sync failed'));
      }
    });

    socket.once('close', (code) => {
      if (!synced) {
        finishWithError(
          new Error(`Jupyter collaboration websocket closed before sync (code ${code})`)
        );
      }
    });
    socket.once('error', () => {
      finishWithError(new Error('Jupyter collaboration websocket connection failed'));
    });
  });
}

function toUint8Array(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const joined = Buffer.concat(data);
    return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
  }
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new Error('Jupyter collaboration sent a non-binary message');
}

function validateConnection(
  connection: JupyterRtcConnection,
  contentPath: string,
  cellId: string
): JupyterRtcConnection {
  if (!connection || typeof connection !== 'object') {
    throw new TypeError('Jupyter connection settings are required');
  }
  if (typeof connection.serverUrl !== 'string') {
    throw new TypeError('Jupyter serverUrl must be an absolute HTTP(S) base URL');
  }

  let serverUrl: URL;
  try {
    serverUrl = new URL(connection.serverUrl);
  } catch {
    throw new TypeError('Jupyter serverUrl must be an absolute HTTP(S) base URL');
  }
  if (
    !['http:', 'https:'].includes(serverUrl.protocol) ||
    serverUrl.username ||
    serverUrl.password ||
    serverUrl.search ||
    serverUrl.hash
  ) {
    throw new TypeError(
      'Jupyter serverUrl must not contain credentials, query parameters, or a fragment'
    );
  }
  if (serverUrl.protocol === 'http:' && !isLoopbackHost(serverUrl.hostname)) {
    throw new TypeError('Jupyter authorization requires HTTPS except for localhost testing');
  }

  if (
    typeof connection.authorization !== 'string' ||
    connection.authorization.length === 0 ||
    /[\r\n]/.test(connection.authorization)
  ) {
    throw new TypeError('Jupyter authorization header is required');
  }

  const timeoutMs = connection.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`Jupyter timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }

  validateContentPath(contentPath);
  if (
    typeof cellId !== 'string' ||
    cellId.length === 0 ||
    cellId.length > 256 ||
    /[\r\n]/.test(cellId)
  ) {
    throw new TypeError('Jupyter cellId is required and must be a short identifier');
  }

  if (!serverUrl.pathname.endsWith('/')) {
    serverUrl.pathname += '/';
  }

  return {
    serverUrl: serverUrl.toString(),
    authorization: connection.authorization,
    timeoutMs,
  };
}

function validateContentPath(contentPath: string): void {
  if (
    typeof contentPath !== 'string' ||
    contentPath.length === 0 ||
    contentPath.length > 1024 ||
    contentPath !== contentPath.trim() ||
    contentPath.startsWith('/') ||
    contentPath.endsWith('/') ||
    contentPath.includes('\\') ||
    contentPath.includes('\0') ||
    !contentPath.toLowerCase().endsWith('.ipynb') ||
    contentPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new TypeError(
      'Jupyter contentPath must be a relative .ipynb path without traversal segments'
    );
  }
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

async function getCollaborationSession(
  connection: JupyterRtcConnection,
  contentPath: string,
  timeoutMs: number
): Promise<CollaborationSession> {
  const url = apiUrl(connection.serverUrl, `api/collaboration/session/${encodePath(contentPath)}`);
  const response = await fetch(url, {
    method: 'PUT',
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: connection.authorization,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ format: 'json', type: 'notebook' }),
  });

  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Jupyter collaboration session request failed (HTTP ${response.status})`);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error('Jupyter collaboration session response was not valid JSON');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new Error('Jupyter collaboration session response had an invalid shape');
  }

  const session = result as Record<string, unknown>;
  if (
    session.format !== 'json' ||
    session.type !== 'notebook' ||
    typeof session.fileId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(session.fileId) ||
    typeof session.sessionId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(session.sessionId)
  ) {
    throw new Error('Jupyter collaboration session response had an invalid shape');
  }

  return { fileId: session.fileId, sessionId: session.sessionId };
}

function apiUrl(serverUrl: string, relativePath: string): string {
  return new URL(relativePath, serverUrl).toString();
}

function toWebSocketUrl(serverUrl: string, relativePath: string): string {
  const url = new URL(relativePath, serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

import { randomUUID } from 'node:crypto';
import { JupyterHttpConnection, type JupyterHttpOptions } from './http-connection.js';

export interface DatalayerTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface DatalayerToolResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

export interface DatalayerExecutionHandle {
  kernelId: string;
  requestId: string;
}

export type DatalayerExecutionObservation = {
  state: 'running' | 'input_required' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  httpStatus?: number;
  result?: Record<string, unknown>;
};

function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw new Error('Invalid Jupyter resource ID');
  }
  return encodeURIComponent(value);
}

/** Existing remote Datalayer MCP protocol. Does not require disclaude_jupyter. */
export class DatalayerJupyterClient extends JupyterHttpConnection {
  private nextId = 0;

  constructor(options: JupyterHttpOptions) {
    super(options);
  }

  async openDocument(
    path: string,
    expectedId?: string
  ): Promise<import('./rtc-document.js').JupyterRtcDocument> {
    const { JupyterRtcDocument } = await import('./rtc-document.js');
    return JupyterRtcDocument.open(this, path, expectedId);
  }

  notebookEntry(path: string): string {
    return this.url(`lab/tree/${path.split('/').map(encodeURIComponent).join('/')}`).href;
  }

  fileEntry(path: string): string {
    return this.url(`files/${path.split('/').map(encodeURIComponent).join('/')}`).href;
  }

  /** Standard kernel channels handshake; captures the process's native message session. */
  async kernelInfo(kernelId: string): Promise<{ kernelId: string; incarnation: string }> {
    const { default: WebSocket } = await import('ws');
    const session = randomUUID();
    const messageId = randomUUID();
    const options = await this.socket(`api/kernels/${id(kernelId)}/channels?session_id=${session}`);
    return await new Promise((resolve, reject) => {
      const socket = new WebSocket(options.url, {
        headers: options.headers,
        followRedirects: false,
        handshakeTimeout: 15000,
        maxPayload: 1024 * 1024,
      });
      let settled = false;
      const finish = (value?: { kernelId: string; incarnation: string }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (value) {
          resolve(value);
        } else {
          reject(new Error('Remote Jupyter kernel readiness could not be verified'));
        }
      };
      const timer = setTimeout(() => finish(), 15000);
      socket.once('error', () => finish());
      socket.once('close', () => finish());
      socket.once('open', () =>
        socket.send(
          JSON.stringify({
            header: {
              msg_id: messageId,
              msg_type: 'kernel_info_request',
              session,
              username: 'disclaude',
              version: '5.3',
              date: new Date().toISOString(),
            },
            parent_header: {},
            metadata: {},
            content: {},
            channel: 'shell',
          })
        )
      );
      socket.on('message', (buffer) => {
        try {
          const message = JSON.parse(buffer.toString()) as {
            header?: { msg_type?: string; session?: string };
            parent_header?: { msg_id?: string };
          };
          if (
            message.header?.msg_type === 'kernel_info_reply' &&
            message.parent_header?.msg_id === messageId &&
            typeof message.header.session === 'string' &&
            message.header.session.length > 0 &&
            message.header.session.length <= 256
          ) {
            finish({ kernelId, incarnation: message.header.session });
          }
        } catch {
          finish();
        }
      });
    });
  }

  /** Direct nbmodel queue submission preserves a recoverable request ID. Never retries. */
  async submitCell(
    kernelId: string,
    documentId: string,
    cellId: string,
    code: string
  ): Promise<
    | { state: 'accepted'; handle: DatalayerExecutionHandle }
    | { state: 'rejected' | 'unknown'; httpStatus?: number }
  > {
    const kernel = id(kernelId);
    id(documentId);
    id(cellId);
    if (!code || Buffer.byteLength(code) > 1_000_000) {
      throw new Error('Invalid Notebook execution source');
    }
    let response: Response;
    try {
      response = await this.response(`api/kernels/${kernel}/execute`, 'POST', {
        code,
        metadata: { document_id: `json:notebook:${documentId}`, cell_id: cellId },
      });
    } catch {
      return { state: 'unknown' };
    }
    await response.body?.cancel();
    if (response.status !== 202) {
      return {
        state: [400, 401, 403, 404, 405, 422].includes(response.status) ? 'rejected' : 'unknown',
        httpStatus: response.status,
      };
    }
    const location = response.headers.get('location');
    try {
      const url = new URL(location ?? '', this.base);
      const match = url.pathname.match(
        /\/api\/kernels\/([^/]+)\/requests\/([A-Za-z0-9_-]{1,256})$/
      );
      if (
        !location ||
        url.origin !== this.base.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !match ||
        match[1] !== kernel ||
        url.pathname !== this.url(`api/kernels/${kernel}/requests/${match[2]}`).pathname
      ) {
        return { state: 'unknown', httpStatus: 202 };
      }
      return { state: 'accepted', handle: { kernelId, requestId: match[2] } };
    } catch {
      return { state: 'unknown', httpStatus: 202 };
    }
  }

  /** nbmodel terminal reads can consume their result; the host must persist it immediately. */
  async observe(handle: DatalayerExecutionHandle): Promise<DatalayerExecutionObservation> {
    try {
      const response = await this.response(
        `api/kernels/${id(handle.kernelId)}/requests/${id(handle.requestId)}`
      );
      if ([404, 410].includes(response.status)) {
        await response.body?.cancel();
        return { state: 'unknown', httpStatus: response.status };
      }
      if (response.status === 202) {
        await response.body?.cancel();
        return { state: 'running', httpStatus: 202 };
      }
      if (![200, 300, 500].includes(response.status)) {
        await response.body?.cancel();
        return { state: 'unknown', httpStatus: response.status };
      }
      const result = JSON.parse(await this.responseText(response)) as Record<string, unknown>;
      if (response.status === 300) {
        return { state: 'input_required', httpStatus: 300, result };
      }
      // 0.1.1a4 serializes outputs as a JSON string and returns kernel errors with HTTP 200.
      const outputs =
        typeof result.outputs === 'string'
          ? (JSON.parse(result.outputs) as unknown)
          : result.outputs;
      if (outputs !== undefined && !Array.isArray(outputs)) {
        return { state: 'unknown', httpStatus: response.status };
      }
      const error = (result.error ??
        (Array.isArray(outputs) ? outputs.find((o) => o?.output_type === 'error') : undefined)) as
        | Record<string, unknown>
        | undefined;
      const normalized = {
        ...result,
        ...(outputs !== undefined ? { outputs } : {}),
        ...(error ? { error } : {}),
      };
      return {
        state:
          error?.ename === 'KeyboardInterrupt'
            ? 'cancelled'
            : response.status === 500 || error || result.status === 'error'
              ? 'failed'
              : 'completed',
        httpStatus: response.status,
        result: normalized,
      };
    } catch {
      return { state: 'unknown' };
    }
  }

  /** Some installed nbmodel versions have no request cancellation handler. No kernel-wide fallback. */
  async stopRequest(
    handle: DatalayerExecutionHandle
  ): Promise<'requested' | 'unsupported' | 'unknown'> {
    try {
      const response = await this.response(
        `api/kernels/${id(handle.kernelId)}/requests/${id(handle.requestId)}`,
        'DELETE'
      );
      await response.body?.cancel();
      return response.status === 204
        ? 'requested'
        : response.status === 405
          ? 'unsupported'
          : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId;
    const response = await this.response('mcp', 'POST', { jsonrpc: '2.0', id, method, params });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Datalayer MCP returned HTTP ${response.status}`);
    }
    const data = JSON.parse(await this.responseText(response)) as Record<string, unknown>;
    if (data.jsonrpc !== '2.0' || data.id !== id) {
      throw new Error('Datalayer MCP response identity mismatch');
    }
    if (data.error) {
      // Remote errors may contain internal paths. Keep the transport diagnostic bounded.
      const error = data.error as Record<string, unknown>;
      throw new Error(`Datalayer MCP ${method} failed: ${String(error.message).slice(0, 600)}`);
    }
    return data.result;
  }

  async initialize(): Promise<Record<string, unknown>> {
    return (await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'disclaude-datalayer-mvp', version: '0.6.3' },
    })) as Record<string, unknown>;
  }

  async listTools(): Promise<DatalayerTool[]> {
    const result = (await this.rpc('tools/list')) as { tools?: DatalayerTool[] };
    if (!Array.isArray(result.tools) || result.tools.length > 256) {
      throw new Error('Invalid Datalayer tool inventory');
    }
    return result.tools;
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<DatalayerToolResult> {
    const result = (await this.rpc('tools/call', {
      name,
      arguments: arguments_,
    })) as DatalayerToolResult;
    if (!result || !Array.isArray(result.content)) {
      throw new Error('Invalid Datalayer tool response');
    }
    return result;
  }

  async json(route: string, method = 'GET', body?: Record<string, unknown>): Promise<unknown> {
    const response = await this.response(route, method, body);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Jupyter API returned HTTP ${response.status}`);
    }
    if (response.status === 204) {
      await response.body?.cancel();
      return undefined;
    }
    return JSON.parse(await this.responseText(response)) as unknown;
  }
}

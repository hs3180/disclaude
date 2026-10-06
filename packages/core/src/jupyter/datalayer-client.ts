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

type InterfaceState = 'available' | 'missing' | 'incompatible' | 'unverified';

export interface DatalayerConnectionInspection {
  backend: 'datalayer';
  serverVersion: string;
  mcp: {
    state: InterfaceState;
    httpStatus?: number;
    protocolVersion?: string;
    tools?: string[];
  };
  nbmodel: { state: InterfaceState; httpStatus?: number };
  rtc: {
    state: 'configured' | 'disabled' | 'unverified';
    httpStatus?: number;
    serverSideExecution?: boolean;
  };
  nbconvert: { state: InterfaceState; httpStatus?: number; formats?: string[] };
  /** Interface discovery does not run a Notebook or prove save/cancel/output behavior. */
  productAcceptance: 'not_verified';
}

class DatalayerProtocolError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly rpcCode?: number
  ) {
    super(message);
  }
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

  private async inspectJson(
    route: string
  ): Promise<{ state: InterfaceState; httpStatus?: number; data?: unknown }> {
    try {
      const response = await this.response(route);
      if (!response.ok) {
        await response.body?.cancel();
        return {
          state: response.status === 404 ? 'missing' : 'unverified',
          httpStatus: response.status,
        };
      }
      try {
        return {
          state: 'available',
          httpStatus: response.status,
          data: JSON.parse(await this.responseText(response)) as unknown,
        };
      } catch {
        return { state: 'incompatible', httpStatus: response.status };
      }
    } catch {
      return { state: 'unverified' };
    }
  }

  private async inspectMcp(): Promise<DatalayerConnectionInspection['mcp']> {
    try {
      const initialized = await this.initialize();
      if (
        !initialized ||
        typeof initialized.protocolVersion !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(initialized.protocolVersion)
      ) {
        return { state: 'incompatible' };
      }
      const tools = await this.listTools();
      return {
        state: 'available',
        protocolVersion: initialized.protocolVersion,
        tools: tools.map((tool) => tool.name),
      };
    } catch (error) {
      return {
        state:
          error instanceof DatalayerProtocolError
            ? error.httpStatus === 404 || error.rpcCode === -32601
              ? 'missing'
              : error.httpStatus === undefined && error.rpcCode === undefined
                ? 'incompatible'
                : 'unverified'
            : 'unverified',
        ...(error instanceof DatalayerProtocolError && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
      };
    }
  }

  private async inspectRtc(): Promise<DatalayerConnectionInspection['rtc']> {
    try {
      const response = await this.response('lab');
      if (!response.ok) {
        await response.body?.cancel();
        return { state: 'unverified', httpStatus: response.status };
      }
      const html = await this.responseText(response);
      const script = html.match(
        /<script\b(?=[^>]*\bid=(["'])jupyter-config-data\1)[^>]*>([\s\S]*?)<\/script>/i
      );
      const config = script ? (JSON.parse(script[2]) as Record<string, unknown>) : undefined;
      return {
        state:
          config?.disableRTC === false
            ? 'configured'
            : config?.disableRTC === true
              ? 'disabled'
              : 'unverified',
        httpStatus: response.status,
        ...(typeof config?.serverSideExecution === 'boolean'
          ? { serverSideExecution: config.serverSideExecution }
          : {}),
      };
    } catch {
      return { state: 'unverified' };
    }
  }

  /** Authenticated reads and MCP discovery only: no document, kernel or execution is created. */
  async inspectConnection(): Promise<DatalayerConnectionInspection> {
    const server = await this.inspectJson('api');
    const version = (server.data as Record<string, unknown> | undefined)?.version;
    if (
      server.state !== 'available' ||
      typeof version !== 'string' ||
      !/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(version) ||
      version.length > 128
    ) {
      throw new Error('Authenticated Jupyter API version could not be verified');
    }
    // The installed nbmodel GET lists a queue without creating a client or task.
    // An unowned random ID avoids opening or inspecting any user's kernel.
    const probeKernel = randomUUID();
    const [mcp, queue, rtc, exported] = await Promise.all([
      this.inspectMcp(),
      this.inspectJson(`api/kernels/${probeKernel}/execute`),
      this.inspectRtc(),
      this.inspectJson('api/nbconvert'),
    ]);
    const queueData = queue.data as Record<string, unknown> | undefined;
    const formats =
      exported.data && typeof exported.data === 'object' && !Array.isArray(exported.data)
        ? Object.keys(exported.data).filter((name) => /^[A-Za-z0-9_-]{1,100}$/.test(name))
        : undefined;
    return {
      backend: 'datalayer',
      serverVersion: version,
      mcp,
      nbmodel: {
        state:
          queue.state !== 'available'
            ? queue.state
            : queueData?.kernel_id === probeKernel && Array.isArray(queueData.requests)
              ? 'available'
              : 'incompatible',
        ...(queue.httpStatus !== undefined ? { httpStatus: queue.httpStatus } : {}),
      },
      rtc,
      nbconvert: {
        state:
          exported.state !== 'available'
            ? exported.state
            : formats?.includes('html')
              ? 'available'
              : 'incompatible',
        ...(exported.httpStatus !== undefined ? { httpStatus: exported.httpStatus } : {}),
        ...(formats ? { formats } : {}),
      },
      productAcceptance: 'not_verified',
    };
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
      throw new DatalayerProtocolError(
        `Datalayer MCP returned HTTP ${response.status}`,
        response.status
      );
    }
    const data = JSON.parse(await this.responseText(response)) as Record<string, unknown>;
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      data.jsonrpc !== '2.0' ||
      data.id !== id
    ) {
      throw new DatalayerProtocolError('Datalayer MCP response identity mismatch');
    }
    if (data.error) {
      // Remote errors can reflect paths or credentials. Only a numeric protocol code is public.
      const error = data.error as Record<string, unknown>;
      const code =
        typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : undefined;
      throw new DatalayerProtocolError(
        `Datalayer MCP ${method} failed${code !== undefined ? ` (code ${code})` : ''}`,
        undefined,
        code
      );
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
    if (
      !result ||
      !Array.isArray(result.tools) ||
      result.tools.length > 256 ||
      result.tools.some(
        (tool) =>
          !tool ||
          typeof tool.name !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(tool.name) ||
          !tool.inputSchema ||
          typeof tool.inputSchema !== 'object' ||
          Array.isArray(tool.inputSchema) ||
          tool.inputSchema.type !== 'object'
      )
    ) {
      throw new DatalayerProtocolError('Invalid Datalayer tool inventory');
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

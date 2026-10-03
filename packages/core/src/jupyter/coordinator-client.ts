import type { CookieJar } from 'tough-cookie';
import type {
  JupyterCellSnapshot,
  JupyterCellSourceEditRequest,
  JupyterCellSourceEditResult,
  JupyterControllerGeneration,
  JupyterExecutionHandle,
  JupyterExecutionObservation,
  JupyterExecutionPort,
  JupyterExecutionStopResult,
  JupyterExecutionSubmitRequest,
  JupyterExecutionSubmitResult,
  JupyterExecutionTarget,
  JupyterNotebookLocator,
  JupyterNotebookPort,
} from './contracts.js';

export interface JupyterCoordinatorOptions {
  /** Explicit remote Jupyter endpoint; Python and kernels belong to that server. */
  baseUrl: string;
  connectionId: string;
  /** Pin a saved connection to its original server namespace. */
  serverNamespace?: string;
  /** Host-owned authentication; never included in a Notebook/tool descriptor. */
  authorization(): Promise<string>;
  /** Dedicated host-owned session store; never pass cookies to Notebook tools. */
  cookieJar?: CookieJar;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface JupyterCoordinatorStatus {
  protocolVersion: 1;
  serverNamespace: string;
  stack: Record<string, string>;
  activeRooms: number;
  pendingRooms: number;
  roomFailures: Record<string, string>;
  maxRooms: number;
  idleSeconds: number;
}

export interface JupyterNotebookOverview {
  notebook: JupyterNotebookLocator;
  cells: Array<{ cellId: string; cellType: string; sourcePreview: string }>;
}

/** Restore only a host-owned jar. No cookie data belongs in a tool descriptor. */
export async function createJupyterCookieJar(serialized?: unknown): Promise<CookieJar> {
  const { CookieJar } = await import('tough-cookie');
  return serialized === undefined
    ? new CookieJar()
    : CookieJar.fromJSON(JSON.stringify(serialized));
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Jupyter coordinator object');
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid Jupyter coordinator ${name}`);
  }
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Jupyter coordinator ${name}`);
  }
  return value;
}

function lease(value: unknown): JupyterControllerGeneration {
  const data = object(value);
  return {
    ownerId: string(data.ownerId, 'ownerId'),
    generation: number(data.generation, 'generation'),
  };
}

function sameNotebook(a: JupyterNotebookLocator, b: JupyterNotebookLocator): boolean {
  return (
    a.identity.connectionId === b.identity.connectionId &&
    a.identity.serverNamespace === b.identity.serverNamespace &&
    a.identity.documentId === b.identity.documentId
  );
}

function locator(value: unknown): JupyterNotebookLocator {
  const data = object(value);
  const identity = object(data.identity);
  return {
    identity: {
      connectionId: string(identity.connectionId, 'connectionId'),
      serverNamespace: string(identity.serverNamespace, 'serverNamespace'),
      documentId: string(identity.documentId, 'documentId'),
    },
    contentPath: string(data.contentPath, 'contentPath'),
  };
}

function snapshot(
  value: unknown,
  notebook: JupyterNotebookLocator,
  cellId: string
): JupyterCellSnapshot {
  const data = object(value);
  const resource = locator(data.notebook);
  if (
    !sameNotebook(resource, notebook) ||
    data.cellId !== cellId ||
    typeof data.source !== 'string'
  ) {
    throw new Error('Jupyter cell response identity mismatch');
  }
  return {
    notebook: resource,
    cellId,
    revision: string(data.revision, 'revision'),
    sourceHash: string(data.sourceHash, 'sourceHash'),
    source: data.source,
  };
}

function handle(
  value: unknown,
  notebook: JupyterNotebookLocator,
  runId: string
): JupyterExecutionHandle {
  const data = object(value);
  const resource = locator(data.notebook);
  if (!sameNotebook(resource, notebook) || data.runId !== runId) {
    throw new Error('Jupyter execution response identity mismatch');
  }
  return {
    notebook: resource,
    cellId: string(data.cellId, 'cellId'),
    expectedRevision: string(data.expectedRevision, 'expectedRevision'),
    sourceHash: string(data.sourceHash, 'sourceHash'),
    kernelId: string(data.kernelId, 'kernelId'),
    kernelIncarnation: string(data.kernelIncarnation, 'kernelIncarnation'),
    runId,
    controller: lease(data.controller),
    requestId: string(data.requestId, 'requestId'),
  };
}

function sameTarget(a: JupyterExecutionTarget, b: JupyterExecutionTarget): boolean {
  return (
    sameNotebook(a.notebook, b.notebook) &&
    a.cellId === b.cellId &&
    a.expectedRevision === b.expectedRevision &&
    a.sourceHash === b.sourceHash &&
    a.kernelId === b.kernelId &&
    a.kernelIncarnation === b.kernelIncarnation &&
    a.runId === b.runId &&
    a.controller.ownerId === b.controller.ownerId &&
    a.controller.generation === b.controller.generation
  );
}

/** Node HTTP ports for the optional extension deployed in the remote Jupyter server. */
export class JupyterCoordinatorClient implements JupyterNotebookPort, JupyterExecutionPort {
  private readonly base: URL;
  private namespace?: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private cookies?: Promise<CookieJar>;
  private connecting?: Promise<JupyterCoordinatorStatus>;
  private connected = false;

  constructor(private readonly options: JupyterCoordinatorOptions) {
    this.base = new URL(options.baseUrl);
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      (this.base.protocol !== 'https:' &&
        !(
          this.base.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(this.base.hostname)
        ))
    ) {
      throw new Error(
        'Jupyter coordinator requires HTTPS or loopback HTTP without URL credentials'
      );
    }
    string(options.connectionId, 'connectionId');
    this.namespace = options.serverNamespace;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 3_000_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      !Number.isSafeInteger(this.maxResponseBytes) ||
      this.maxResponseBytes < 1
    ) {
      throw new Error('Invalid Jupyter coordinator request limits');
    }
    this.base.pathname = this.base.pathname.replace(/\/?$/, '/');
  }

  private async request(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const authorization = await this.options.authorization();
    if (!authorization || /[\r\n]/.test(authorization)) {
      throw new Error('Jupyter connection authentication is unavailable');
    }
    const url = new URL(`api/disclaude${path}`, this.base);
    this.cookies ??= this.options.cookieJar
      ? Promise.resolve(this.options.cookieJar)
      : import('tough-cookie').then(({ CookieJar }) => new CookieJar());
    const cookies = await this.cookies;
    const cookie = await cookies.getCookieString(url.href);
    if (Buffer.byteLength(cookie) > 16_384) {
      throw new Error('Jupyter session cookie limit exceeded');
    }
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: authorization,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    try {
      const updates = response.headers.getSetCookie();
      if (updates.length > 16 || updates.some((value) => Buffer.byteLength(value) > 8192)) {
        throw new Error('Jupyter session cookie limit exceeded');
      }
      for (const update of updates) {
        await cookies.setCookie(update, url.href, { ignoreError: true });
      }
      if ((await cookies.serialize()).cookies.length > 32) {
        await cookies.removeAllCookies();
        throw new Error('Jupyter session cookie limit exceeded');
      }
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Jupyter coordinator returned HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Jupyter coordinator response body is missing');
    }
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        length += value.byteLength;
        if (length > this.maxResponseBytes) {
          throw new Error('Jupyter coordinator response limit exceeded');
        }
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }

  async connect(): Promise<JupyterCoordinatorStatus> {
    this.connecting ??= this.loadStatus();
    const pending = this.connecting;
    try {
      return await pending;
    } finally {
      if (this.connecting === pending) {
        this.connecting = undefined;
      }
    }
  }

  private async loadStatus(): Promise<JupyterCoordinatorStatus> {
    this.connected = false;
    const data = object(await this.request(''));
    if (data.protocolVersion !== 1) {
      throw new Error('Unsupported Jupyter coordinator protocol');
    }
    const namespace = string(data.serverNamespace, 'serverNamespace');
    if (this.namespace && this.namespace !== namespace) {
      throw new Error('Jupyter connection now points to another server namespace');
    }
    this.namespace = namespace;
    const stack = object(data.stack);
    if (!Object.values(stack).every((value) => typeof value === 'string')) {
      throw new Error('Invalid Jupyter coordinator stack');
    }
    const roomFailures = object(data.roomFailures);
    if (!Object.values(roomFailures).every((value) => typeof value === 'string')) {
      throw new Error('Invalid Jupyter room diagnostics');
    }
    const status: JupyterCoordinatorStatus = {
      protocolVersion: 1,
      serverNamespace: namespace,
      stack: stack as Record<string, string>,
      activeRooms: number(data.activeRooms, 'activeRooms'),
      pendingRooms: number(data.pendingRooms, 'pendingRooms'),
      roomFailures: roomFailures as Record<string, string>,
      maxRooms: number(data.maxRooms, 'maxRooms'),
      idleSeconds:
        typeof data.idleSeconds === 'number' &&
        Number.isFinite(data.idleSeconds) &&
        data.idleSeconds >= 0
          ? data.idleSeconds
          : number(data.idleSeconds, 'idleSeconds'),
    };
    this.connected = true;
    return status;
  }

  private async operation(
    notebook: JupyterNotebookLocator,
    name: string,
    fields: Record<string, unknown> = {}
  ): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }
    if (
      notebook.identity.connectionId !== this.options.connectionId ||
      notebook.identity.serverNamespace !== this.namespace
    ) {
      throw new Error('Notebook does not belong to this Jupyter connection');
    }
    return this.request(`/notebooks/${encodeURIComponent(notebook.identity.documentId)}/${name}`, {
      notebook,
      ...fields,
    });
  }

  async openNotebook(contentPath: string): Promise<JupyterNotebookLocator> {
    if (!this.connected) {
      await this.connect();
    }
    const resource = locator(
      await this.request('/notebooks', { contentPath, connectionId: this.options.connectionId })
    );
    if (
      resource.identity.connectionId !== this.options.connectionId ||
      resource.identity.serverNamespace !== this.namespace
    ) {
      throw new Error('Opened Notebook identity mismatch');
    }
    return resource;
  }

  async describeNotebook(notebook: JupyterNotebookLocator): Promise<JupyterNotebookOverview> {
    const data = object(await this.operation(notebook, 'describe'));
    const resource = locator(data.notebook);
    if (
      !sameNotebook(resource, notebook) ||
      !Array.isArray(data.cells) ||
      data.cells.length > 1024
    ) {
      throw new Error('Notebook overview identity or cell limit changed');
    }
    return {
      notebook: resource,
      cells: data.cells.map((value) => {
        const cell = object(value);
        const preview = typeof cell.sourcePreview === 'string' ? cell.sourcePreview : undefined;
        if (preview === undefined || Buffer.byteLength(preview) > 8000) {
          throw new Error('Invalid Notebook source preview');
        }
        return {
          cellId: string(cell.cellId, 'cellId'),
          cellType: string(cell.cellType, 'cellType'),
          sourcePreview: preview,
        };
      }),
    };
  }

  async claimControl(
    notebook: JupyterNotebookLocator,
    ownerId: string,
    expectedGeneration: number
  ): Promise<JupyterControllerGeneration> {
    return lease(await this.operation(notebook, 'control', { ownerId, expectedGeneration }));
  }

  async currentController(
    notebook: JupyterNotebookLocator
  ): Promise<JupyterControllerGeneration | null> {
    const result = await this.operation(notebook, 'control', { action: 'read' });
    return result === null ? null : lease(result);
  }

  async controlState(notebook: JupyterNotebookLocator): Promise<{
    controller: JupyterControllerGeneration | null;
    paused: boolean;
  }> {
    const data = object(await this.operation(notebook, 'control-state'));
    if (typeof data.paused !== 'boolean') {
      throw new Error('Invalid Notebook control state');
    }
    return {
      controller: data.controller === null ? null : lease(data.controller),
      paused: data.paused,
    };
  }

  /** Atomically fence this generation and cancel its entire unsent queue. */
  async stopOwner(
    notebook: JupyterNotebookLocator,
    controller: JupyterControllerGeneration
  ): Promise<
    | { state: 'requested'; runIds: string[] }
    | { state: 'ownership_lost'; currentGeneration: number }
    | { state: 'unknown'; reason: string }
  > {
    try {
      const data = object(await this.operation(notebook, 'stop-owner', { controller }));
      if (data.state === 'ownership_lost') {
        return {
          state: 'ownership_lost',
          currentGeneration: number(data.currentGeneration, 'currentGeneration'),
        };
      }
      if (data.state !== 'requested' || !Array.isArray(data.runIds) || data.runIds.length > 256) {
        throw new Error('Invalid Notebook owner stop acknowledgment');
      }
      return { state: 'requested', runIds: data.runIds.map((value) => string(value, 'runId')) };
    } catch {
      return { state: 'unknown', reason: 'Notebook owner stop outcome could not be verified' };
    }
  }

  /** Select a kernelspec and bind a kernel through the remote server API. */
  async ensureKernel(
    notebook: JupyterNotebookLocator,
    kernelName = 'python3'
  ): Promise<{ kernelId: string; kernelIncarnation: string }> {
    const result = object(await this.operation(notebook, 'kernel', { kernelName }));
    return {
      kernelId: string(result.kernelId, 'kernelId'),
      kernelIncarnation: string(result.kernelIncarnation, 'kernelIncarnation'),
    };
  }

  async readCell(notebook: JupyterNotebookLocator, cellId: string): Promise<JupyterCellSnapshot> {
    return snapshot(await this.operation(notebook, 'read-cell', { cellId }), notebook, cellId);
  }

  async editCellSource(
    request: JupyterCellSourceEditRequest
  ): Promise<JupyterCellSourceEditResult> {
    try {
      const data = object(await this.operation(request.notebook, 'edit-cell', { ...request }));
      if (data.state === 'applied') {
        return {
          state: 'applied',
          snapshot: snapshot(data.snapshot, request.notebook, request.cellId),
        };
      }
      if (data.state === 'conflict') {
        return {
          state: 'conflict',
          current: snapshot(data.current, request.notebook, request.cellId),
        };
      }
      if (data.state === 'ownership_lost') {
        return {
          state: 'ownership_lost',
          currentGeneration: number(data.currentGeneration, 'currentGeneration'),
        };
      }
      throw new Error('Unknown Jupyter edit outcome');
    } catch (error) {
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : 'Jupyter edit outcome unknown',
      };
    }
  }

  async submit(request: JupyterExecutionSubmitRequest): Promise<JupyterExecutionSubmitResult> {
    try {
      const data = object(
        await this.operation(request.target.notebook, 'submit', {
          target: request.target,
          source: request.source,
        })
      );
      if (data.state === 'accepted') {
        const accepted = handle(data.handle, request.target.notebook, request.target.runId);
        if (!sameTarget(accepted, request.target)) {
          throw new Error('Accepted execution target mismatch');
        }
        return { state: 'accepted', handle: accepted };
      }
      if (data.state === 'rejected' || data.state === 'not_started') {
        return { state: data.state, reason: string(data.reason, 'reason') };
      }
      if (data.state === 'unknown' && data.runId === request.target.runId) {
        return { state: 'unknown', runId: data.runId, reason: string(data.reason, 'reason') };
      }
      throw new Error('Unknown Jupyter submission outcome');
    } catch (error) {
      // No network or parse error authorizes a second POST. Reconcile runId.
      return {
        state: 'unknown',
        runId: request.target.runId,
        reason: error instanceof Error ? error.message : 'Jupyter submission outcome unknown',
      };
    }
  }

  async getStatus(
    notebook: JupyterNotebookLocator,
    runId: string
  ): Promise<JupyterExecutionObservation> {
    try {
      const data = object(await this.operation(notebook, 'status', { runId }));
      if (data.runId !== runId) {
        throw new Error('Execution observation runId mismatch');
      }
      const current = data.handle ? handle(data.handle, notebook, runId) : undefined;
      if (data.state === 'unknown') {
        return { runId, state: 'unknown', handle: current, reason: string(data.reason, 'reason') };
      }
      if (!current) {
        throw new Error('Execution observation has no handle');
      }
      if (
        [
          'queued',
          'running',
          'input_required',
          'stopping',
          'completed',
          'failed',
          'cancelled',
        ].includes(String(data.state))
      ) {
        // Preserve bounded execution/persistence diagnostics from the backend.
        return {
          runId,
          state: data.state,
          handle: current,
          details: data.details,
        } as JupyterExecutionObservation;
      }
      throw new Error('Unknown Jupyter execution state');
    } catch (error) {
      return {
        runId,
        state: 'unknown',
        reason: error instanceof Error ? error.message : 'Jupyter observation unavailable',
      };
    }
  }

  async stop(
    execution: JupyterExecutionHandle,
    controller: JupyterControllerGeneration
  ): Promise<JupyterExecutionStopResult> {
    try {
      const data = object(
        await this.operation(execution.notebook, 'stop', { handle: execution, controller })
      );
      if (data.state === 'requested' || data.state === 'not_found') {
        return { state: data.state };
      }
      if (data.state === 'ownership_lost') {
        return {
          state: 'ownership_lost',
          currentGeneration: number(data.currentGeneration, 'currentGeneration'),
        };
      }
      if (data.state === 'unknown') {
        return { state: 'unknown', reason: string(data.reason, 'reason') };
      }
      throw new Error('Unknown Jupyter stop outcome');
    } catch (error) {
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : 'Jupyter stop outcome unknown',
      };
    }
  }
}

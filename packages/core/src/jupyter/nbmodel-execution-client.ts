import { isIP } from 'node:net';

/**
 * Small client for the execution REST API exposed by jupyter-server-nbmodel.
 *
 * The request handle is safe to persist: it contains a kernel ID and a request
 * ID, never a credential or an arbitrary URL. A missing request after a server
 * restart is reported as unknown; this client never retries execution.
 */

export interface JupyterNbmodelConnection {
  /** Jupyter Server URL, including any deployment prefix, without credentials. */
  serverUrl: string;
  /** Value for the HTTP Authorization header (for example, `token …`). */
  authorization: string;
  /** Timeout for one HTTP request. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
}

export interface JupyterNbmodelExecutionHandle {
  kernelId: string;
  requestId: string;
  target: JupyterNbmodelExecutionTarget;
}

export interface JupyterNbmodelExecutionTarget {
  /** Relative path to the server-managed `.ipynb` file. */
  documentPath: string;
  /** Stable ID of the code cell whose execution and outputs are being tracked. */
  cellId: string;
  /** Optional live collaboration room ID, when already known. */
  documentId?: string;
}

export type JupyterNbmodelSubmitResult =
  | { state: 'accepted'; handle: JupyterNbmodelExecutionHandle }
  | { state: 'rejected'; reason: string; httpStatus: number }
  | { state: 'not_started'; reason: 'cancelled_before_submit' }
  | { state: 'unknown'; reason: string; httpStatus?: number };

export type JupyterNbmodelExecutionObservation =
  | {
      state: 'running';
      handle: JupyterNbmodelExecutionHandle;
      requestStatus?: string;
      outputs: unknown[];
    }
  | {
      state: 'input_required';
      handle: JupyterNbmodelExecutionHandle;
      outputs: unknown[];
    }
  | {
      /** The kernel request completed; this is not an RTC or file-save acknowledgment. */
      state: 'completed';
      handle: JupyterNbmodelExecutionHandle;
      executionCount?: number | null;
      outputs: unknown[];
    }
  | {
      /** The kernel reported an execution error; this is not an RTC or file-save acknowledgment. */
      state: 'failed';
      handle: JupyterNbmodelExecutionHandle;
      executionCount?: number | null;
      errorName?: string;
      outputs: unknown[];
    }
  | {
      /** A DELETE was acknowledged, but the kernel has not reported a terminal result yet. */
      state: 'stopping';
      handle: JupyterNbmodelExecutionHandle;
      outputs: unknown[];
    }
  | {
      /**
       * The caller's stop request was followed by a confirmed KeyboardInterrupt.
       * This is not an RTC or file-save acknowledgment.
       */
      state: 'cancelled';
      handle: JupyterNbmodelExecutionHandle;
      executionCount?: number | null;
      outputs: unknown[];
    }
  | {
      state: 'unknown';
      handle: JupyterNbmodelExecutionHandle;
      reason: string;
      httpStatus?: number;
    };

export type JupyterNbmodelCancelResult =
  | { state: 'requested'; httpStatus: 204 }
  | { state: 'not_found'; httpStatus: 404 }
  | { state: 'unknown'; reason: string; httpStatus?: number };

export interface JupyterNbmodelExecutionClientOptions {
  /** Fetch implementation override for tests and controlled runtimes. */
  fetch?: typeof fetch;
  /** Delay between status requests. Defaults to 250 milliseconds. */
  pollIntervalMs?: number;
  /** Maximum time to wait for a terminal execution state. Defaults to 5 minutes. */
  maxWaitMs?: number;
  /** Maximum JSON response body size. Defaults to 8 MiB. */
  maxResponseBytes?: number;
}

export interface JupyterNbmodelWaitOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

interface NormalizedConnection {
  baseUrl: URL;
  authorization: string;
  requestTimeoutMs: number;
}

type RequestResult =
  | {
      state: 'response';
      status: number;
      headers: Headers;
      body: unknown;
      bodyValid: boolean;
    }
  | { state: 'transport_error'; reason: 'aborted' | 'timeout' | 'network' | 'response_too_large' };

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const MAX_WAIT_MS = 60 * 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,128}$/;

export class JupyterNbmodelExecutionClient {
  private readonly connection: NormalizedConnection;
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly maxResponseBytes: number;
  private readonly cancellationRequests = new Map<string, Promise<JupyterNbmodelCancelResult>>();

  constructor(
    connection: JupyterNbmodelConnection,
    options: JupyterNbmodelExecutionClientOptions = {}
  ) {
    this.connection = validateConnection(connection);
    this.fetchImpl = options.fetch ?? fetch;
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      MAX_WAIT_MS,
      'pollIntervalMs'
    );
    this.maxWaitMs = positiveInteger(
      options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      MAX_WAIT_MS,
      'maxWaitMs'
    );
    this.maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    );
  }

  /** Submit exactly once. A lost response returns `unknown`; it is never retried. */
  async submit(
    kernelId: string,
    code: string,
    target: JupyterNbmodelExecutionTarget,
    signal?: AbortSignal
  ): Promise<JupyterNbmodelSubmitResult> {
    validateId(kernelId, 'kernelId');
    validateTarget(target);
    if (typeof code !== 'string' || code.length === 0 || code.length > 2_000_000) {
      throw new TypeError('code must be a non-empty string of at most 2,000,000 characters');
    }
    if (signal?.aborted) {
      return { state: 'not_started', reason: 'cancelled_before_submit' };
    }

    // Once sent, keep the POST alive long enough to capture its request ID.
    // If the caller aborts during submission, execute() cancels as soon as the
    // handle arrives. A transport timeout still produces an honest unknown.
    const result = await this.request(
      'POST',
      this.apiUrl(`api/kernels/${encodeURIComponent(kernelId)}/execute`),
      {
        code,
        metadata: {
          document_path: target.documentPath,
          cell_id: target.cellId,
          ...(target.documentId === undefined ? {} : { document_id: target.documentId }),
        },
      }
    );

    if (result.state === 'transport_error') {
      return { state: 'unknown', reason: `submit_${result.reason}` };
    }
    if (result.status !== 202) {
      if (result.status >= 400 && result.status < 500) {
        return {
          state: 'rejected',
          reason: 'Jupyter rejected the execution request',
          httpStatus: result.status,
        };
      }
      return {
        state: 'unknown',
        reason:
          result.status >= 300 && result.status < 400
            ? 'submit_redirect_blocked'
            : 'unexpected_submit_status',
        httpStatus: result.status,
      };
    }

    const location = result.headers.get('location');
    const requestId = location ? this.requestIdFromLocation(location, kernelId) : undefined;
    if (!requestId) {
      return {
        state: 'unknown',
        reason: 'accepted_request_missing_safe_location',
        httpStatus: 202,
      };
    }
    return {
      state: 'accepted',
      handle: { kernelId, requestId, target: structuredClone(target) },
    };
  }

  /** Read the server-side request state without replaying code. */
  async getStatus(
    handle: JupyterNbmodelExecutionHandle,
    signal?: AbortSignal
  ): Promise<JupyterNbmodelExecutionObservation> {
    validateHandle(handle);
    const result = await this.request('GET', this.requestUrl(handle), undefined, signal);

    if (result.state === 'transport_error') {
      return { state: 'unknown', handle, reason: `status_${result.reason}` };
    }
    if (result.status === 404 || result.status === 410) {
      return {
        state: 'unknown',
        handle,
        reason: 'server_no_longer_has_request',
        httpStatus: result.status,
      };
    }
    if (result.status >= 300 && result.status < 400) {
      return {
        state: 'unknown',
        handle,
        reason: 'status_redirect_blocked',
        httpStatus: result.status,
      };
    }
    if (result.status === 300) {
      const record = asRecord(result.body);
      const mismatch = responseIdentityMismatch(record, handle);
      if (mismatch) {
        return { state: 'unknown', handle, reason: mismatch, httpStatus: result.status };
      }
      const outputs = getOutputs(result.body);
      return outputs
        ? { state: 'input_required', handle, outputs }
        : malformedOutputs(handle, result.status);
    }
    if (result.status === 202) {
      if (!result.bodyValid) {
        return {
          state: 'unknown',
          handle,
          reason: 'malformed_status_response',
          httpStatus: result.status,
        };
      }
      const record = asRecord(result.body);
      const mismatch = responseIdentityMismatch(record, handle);
      if (mismatch) {
        return { state: 'unknown', handle, reason: mismatch, httpStatus: result.status };
      }
      const executionRecord = asRecord(record?.execution) ?? record;
      const terminal = terminalObservation(handle, record, executionRecord);
      if (terminal) {
        return terminal;
      }
      if (record?.request_status === 'complete' || record?.request_status === 'completed') {
        return {
          state: 'unknown',
          handle,
          reason: 'completed_without_execution_result',
          httpStatus: result.status,
        };
      }
      const outputs = getOutputs(executionRecord?.outputs ?? record?.outputs);
      return outputs
        ? {
            state: 'running',
            handle,
            requestStatus: stringValue(record?.request_status),
            outputs,
          }
        : malformedOutputs(handle, result.status);
    }
    if (result.status === 500 && result.bodyValid) {
      const record = asRecord(result.body);
      const mismatch = responseIdentityMismatch(record, handle);
      if (mismatch) {
        return { state: 'unknown', handle, reason: mismatch, httpStatus: result.status };
      }
      const executionRecord = asRecord(record?.execution) ?? record;
      const terminal = terminalObservation(handle, record, executionRecord);
      return terminal?.state === 'failed'
        ? terminal
        : {
            state: 'unknown',
            handle,
            reason: 'server_error_without_execution_result',
            httpStatus: result.status,
          };
    }
    if (result.status !== 200) {
      return {
        state: 'unknown',
        handle,
        reason:
          result.status >= 400 && result.status < 500
            ? 'status_request_rejected'
            : 'unexpected_status_code',
        httpStatus: result.status,
      };
    }
    if (!result.bodyValid) {
      return {
        state: 'unknown',
        handle,
        reason: 'malformed_status_response',
        httpStatus: result.status,
      };
    }

    const record = asRecord(result.body);
    const mismatch = responseIdentityMismatch(record, handle);
    if (mismatch) {
      return { state: 'unknown', handle, reason: mismatch, httpStatus: result.status };
    }
    const executionRecord = asRecord(record?.execution) ?? record;
    const terminal = terminalObservation(handle, record, executionRecord);
    if (terminal) {
      return terminal;
    }
    if (record?.request_status === 'complete' || record?.request_status === 'completed') {
      return {
        state: 'unknown',
        handle,
        reason: 'completed_without_execution_result',
        httpStatus: result.status,
      };
    }
    if (isRunningStatus(record?.request_status) || isRunningStatus(executionRecord?.status)) {
      const outputs = getOutputs(executionRecord?.outputs ?? record?.outputs);
      if (!outputs) {
        return malformedOutputs(handle, result.status);
      }
      return {
        state: 'running',
        handle,
        requestStatus: stringValue(record?.request_status ?? executionRecord?.status),
        outputs,
      };
    }
    return {
      state: 'unknown',
      handle,
      reason: 'unrecognized_terminal_status',
      httpStatus: result.status,
    };
  }

  /**
   * Ask the server to interrupt this exact request. HTTP 204 only acknowledges
   * the request; callers must poll until the kernel reports a terminal state.
   * Calls for the same handle on this client share one DELETE because the
   * server may otherwise interrupt the next cell after the queue advances.
   */
  cancel(handle: JupyterNbmodelExecutionHandle): Promise<JupyterNbmodelCancelResult> {
    validateHandle(handle);
    const key = JSON.stringify([handle.kernelId, handle.requestId]);
    const existing = this.cancellationRequests.get(key);
    if (existing) {
      return existing;
    }
    const cancellation = this.sendCancel(handle);
    this.cancellationRequests.set(key, cancellation);
    return cancellation;
  }

  private async sendCancel(
    handle: JupyterNbmodelExecutionHandle
  ): Promise<JupyterNbmodelCancelResult> {
    const result = await this.request('DELETE', this.requestUrl(handle));
    if (result.state === 'transport_error') {
      return { state: 'unknown', reason: `cancel_${result.reason}` };
    }
    if (result.status === 204) {
      return { state: 'requested', httpStatus: 204 };
    }
    if (result.status === 404) {
      return { state: 'not_found', httpStatus: 404 };
    }
    return {
      state: 'unknown',
      reason:
        result.status >= 300 && result.status < 400
          ? 'cancel_redirect_blocked'
          : 'unexpected_cancel_status',
      httpStatus: result.status,
    };
  }

  /**
   * Poll a request and, when aborted, ask Jupyter to cancel it and continue
   * reconciling. A confirmed KeyboardInterrupt is distinct from a 204 ack.
   */
  async waitForCompletion(
    handle: JupyterNbmodelExecutionHandle,
    options: JupyterNbmodelWaitOptions = {}
  ): Promise<JupyterNbmodelExecutionObservation> {
    validateHandle(handle);
    const pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? this.pollIntervalMs,
      MAX_WAIT_MS,
      'pollIntervalMs'
    );
    const maxWaitMs = positiveInteger(
      options.maxWaitMs ?? this.maxWaitMs,
      MAX_WAIT_MS,
      'maxWaitMs'
    );
    const deadline = Date.now() + maxWaitMs;
    let cancellationRequested = false;
    let latestOutputs: unknown[] = [];

    while (Date.now() < deadline) {
      if (options.signal?.aborted && !cancellationRequested) {
        const cancellation = await this.cancel(handle);
        if (cancellation.state === 'requested') {
          cancellationRequested = true;
        } else {
          const afterCancel = await this.getStatus(handle);
          if (isTerminal(afterCancel)) {
            return afterCancel;
          }
          return {
            state: 'unknown',
            handle,
            reason: 'cancellation_not_confirmed',
            httpStatus: cancellation.state === 'not_found' ? 404 : cancellation.httpStatus,
          };
        }
      }

      const observation = await this.getStatus(
        handle,
        cancellationRequested ? undefined : options.signal
      );
      if (options.signal?.aborted && !cancellationRequested) {
        continue;
      }
      latestOutputs = outputsOf(observation) ?? latestOutputs;

      if (isTerminal(observation)) {
        if (
          cancellationRequested &&
          observation.state === 'failed' &&
          isKeyboardInterrupt(observation)
        ) {
          return {
            state: 'cancelled',
            handle,
            executionCount: observation.executionCount,
            outputs: observation.outputs,
          };
        }
        return observation;
      }
      if (observation.state === 'input_required' || observation.state === 'unknown') {
        return observation;
      }

      await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    if (cancellationRequested) {
      return { state: 'stopping', handle, outputs: latestOutputs };
    }
    if (options.signal?.aborted) {
      const cancellation = await this.cancel(handle);
      if (cancellation.state === 'requested') {
        const afterCancel = await this.getStatus(handle);
        if (isTerminal(afterCancel)) {
          return afterCancel.state === 'failed' && isKeyboardInterrupt(afterCancel)
            ? {
                state: 'cancelled',
                handle,
                executionCount: afterCancel.executionCount,
                outputs: afterCancel.outputs,
              }
            : afterCancel;
        }
        return { state: 'stopping', handle, outputs: outputsOf(afterCancel) ?? latestOutputs };
      }
      return {
        state: 'unknown',
        handle,
        reason: 'cancellation_not_confirmed',
        httpStatus: cancellation.state === 'not_found' ? 404 : cancellation.httpStatus,
      };
    }
    const last = await this.getStatus(handle, options.signal?.aborted ? undefined : options.signal);
    return last;
  }

  /** Submit once and reconcile to completion, honoring cancellation if requested. */
  async execute(
    kernelId: string,
    code: string,
    target: JupyterNbmodelExecutionTarget,
    options: JupyterNbmodelWaitOptions = {}
  ): Promise<JupyterNbmodelSubmitResult | JupyterNbmodelExecutionObservation> {
    if (options.signal?.aborted) {
      return { state: 'not_started', reason: 'cancelled_before_submit' };
    }
    const submission = await this.submit(kernelId, code, target);
    if (submission.state !== 'accepted') {
      return submission;
    }
    return this.waitForCompletion(submission.handle, options);
  }

  private apiUrl(relativePath: string): URL {
    return new URL(relativePath, this.connection.baseUrl);
  }

  private requestUrl(handle: JupyterNbmodelExecutionHandle): URL {
    return this.apiUrl(
      `api/kernels/${encodeURIComponent(handle.kernelId)}/requests/${encodeURIComponent(handle.requestId)}`
    );
  }

  private requestIdFromLocation(location: string, kernelId: string): string | undefined {
    try {
      const resolved = new URL(location, this.connection.baseUrl);
      const base = this.connection.baseUrl;
      if (
        resolved.origin !== base.origin ||
        resolved.search ||
        resolved.hash ||
        resolved.username ||
        resolved.password
      ) {
        return undefined;
      }
      const relativePath = resolved.pathname.startsWith(base.pathname)
        ? resolved.pathname.slice(base.pathname.length)
        : base.pathname !== '/' && resolved.pathname.startsWith('/api/')
          ? resolved.pathname.slice(1)
          : undefined;
      if (relativePath === undefined) {
        return undefined;
      }
      const segments = relativePath
        .split('/')
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
      if (
        segments.length !== 5 ||
        segments[0] !== 'api' ||
        segments[1] !== 'kernels' ||
        segments[2] !== kernelId ||
        segments[3] !== 'requests' ||
        !SAFE_ID.test(segments[4])
      ) {
        return undefined;
      }
      return segments[4];
    } catch {
      return undefined;
    }
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    url: URL,
    body?: unknown,
    externalSignal?: AbortSignal
  ): Promise<RequestResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.connection.requestTimeoutMs);
    const abort = (): void => controller.abort();
    if (externalSignal?.aborted) {
      clearTimeout(timeout);
      return { state: 'transport_error', reason: 'aborted' };
    }
    externalSignal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.connection.authorization,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readLimitedText(response, this.maxResponseBytes);
      if (text === undefined) {
        return { state: 'transport_error', reason: 'response_too_large' };
      }
      if (text.length === 0) {
        return {
          state: 'response',
          status: response.status,
          headers: response.headers,
          body: undefined,
          bodyValid: true,
        };
      }
      try {
        return {
          state: 'response',
          status: response.status,
          headers: response.headers,
          body: JSON.parse(text) as unknown,
          bodyValid: true,
        };
      } catch {
        return {
          state: 'response',
          status: response.status,
          headers: response.headers,
          body: undefined,
          bodyValid: false,
        };
      }
    } catch {
      return {
        state: 'transport_error',
        reason: externalSignal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network',
      };
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abort);
    }
  }
}

function validateConnection(connection: JupyterNbmodelConnection): NormalizedConnection {
  if (!connection || typeof connection !== 'object' || typeof connection.serverUrl !== 'string') {
    throw new TypeError('A Jupyter Server URL is required');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(connection.serverUrl);
  } catch {
    throw new TypeError('serverUrl must be an absolute HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new TypeError('serverUrl must not contain credentials, query parameters, or a fragment');
  }
  if (baseUrl.protocol === 'http:' && !isLoopbackHost(baseUrl.hostname)) {
    throw new TypeError('Jupyter authorization requires HTTPS except for localhost testing');
  }
  if (
    typeof connection.authorization !== 'string' ||
    connection.authorization.length === 0 ||
    /[\r\n]/.test(connection.authorization)
  ) {
    throw new TypeError('Jupyter authorization header is required');
  }
  const requestTimeoutMs = positiveInteger(
    connection.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS,
    'requestTimeoutMs'
  );
  if (!baseUrl.pathname.endsWith('/')) {
    baseUrl.pathname += '/';
  }
  return { baseUrl, authorization: connection.authorization, requestTimeoutMs };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    (isIP(normalized) === 6 && normalized === '::1') ||
    (isIP(normalized) === 4 && normalized.split('.')[0] === '127')
  );
}

function positiveInteger(value: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

function validateId(value: string, name: string): void {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TypeError(`${name} must be a short Jupyter identifier`);
  }
}

function validateHandle(handle: JupyterNbmodelExecutionHandle): void {
  if (!handle || typeof handle !== 'object') {
    throw new TypeError('A Jupyter execution handle is required');
  }
  validateId(handle.kernelId, 'kernelId');
  validateId(handle.requestId, 'requestId');
  validateTarget(handle.target);
}

function responseIdentityMismatch(
  response: Record<string, unknown> | undefined,
  handle: JupyterNbmodelExecutionHandle
): string | undefined {
  if (!response) {
    return undefined;
  }
  if (response.request_id !== undefined && response.request_id !== handle.requestId) {
    return 'request_identity_mismatch';
  }
  if (response.kernel_id !== undefined && response.kernel_id !== handle.kernelId) {
    return 'kernel_identity_mismatch';
  }
  if (response.cell_id !== undefined && response.cell_id !== handle.target.cellId) {
    return 'cell_identity_mismatch';
  }
  if (
    response.document_path !== undefined &&
    response.document_path !== handle.target.documentPath
  ) {
    return 'document_path_mismatch';
  }
  return undefined;
}

function validateTarget(target: JupyterNbmodelExecutionTarget): void {
  if (!target || typeof target !== 'object') {
    throw new TypeError('A Jupyter notebook path and cell ID are required');
  }
  const { documentPath, cellId, documentId } = target;
  if (
    typeof documentPath !== 'string' ||
    documentPath.length === 0 ||
    documentPath.length > 1024 ||
    documentPath !== documentPath.trim() ||
    documentPath.startsWith('/') ||
    documentPath.endsWith('/') ||
    documentPath.includes('\\') ||
    documentPath.includes('\0') ||
    /[\u0001-\u001f?#]/.test(documentPath) ||
    !documentPath.toLowerCase().endsWith('.ipynb') ||
    documentPath.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new TypeError('documentPath must be a relative .ipynb path without traversal segments');
  }
  validateId(cellId, 'cellId');
  if (
    documentId !== undefined &&
    (typeof documentId !== 'string' || !isJupyterDocumentId(documentId))
  ) {
    throw new TypeError('documentId must be a short Jupyter collaboration ID');
  }
}

function isJupyterDocumentId(value: string): boolean {
  const segments = value.split(':');
  return (
    segments.length === 3 && segments.every((segment) => /^[A-Za-z0-9._~-]{1,128}$/.test(segment))
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isRunningStatus(value: unknown): boolean {
  return (
    value === 'queued' || value === 'pending' || value === 'running' || value === 'in_progress'
  );
}

function getOutputs(value: unknown): unknown[] | undefined {
  if (value === undefined || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function malformedOutputs(
  handle: JupyterNbmodelExecutionHandle,
  httpStatus: number
): JupyterNbmodelExecutionObservation {
  return {
    state: 'unknown',
    handle,
    reason: 'malformed_execution_outputs',
    httpStatus,
  };
}

function terminalObservation(
  handle: JupyterNbmodelExecutionHandle,
  request: Record<string, unknown> | undefined,
  execution: Record<string, unknown> | undefined
): JupyterNbmodelExecutionObservation | undefined {
  const requestStatus = request?.request_status;
  const executionStatus = execution?.status;
  const executionCount =
    typeof execution?.execution_count === 'number' || execution?.execution_count === null
      ? execution.execution_count
      : undefined;
  const outputs = getOutputs(execution?.outputs ?? request?.outputs);

  if (!outputs) {
    return {
      state: 'unknown',
      handle,
      reason: 'malformed_execution_outputs',
    };
  }

  if (
    executionStatus === 'ok' ||
    executionStatus === 'success' ||
    (requestStatus === 'complete' && executionStatus === 'completed')
  ) {
    return { state: 'completed', handle, executionCount, outputs };
  }
  if (executionStatus === 'error' || executionStatus === 'failed') {
    return {
      state: 'failed',
      handle,
      executionCount,
      errorName: findErrorName(execution, outputs),
      outputs,
    };
  }
  return undefined;
}

function findErrorName(
  execution: Record<string, unknown> | undefined,
  outputs: unknown[]
): string | undefined {
  const direct = stringValue(execution?.ename);
  if (direct) {
    return direct;
  }
  for (const value of outputs) {
    const output = asRecord(value);
    if (output?.output_type === 'error' && typeof output.ename === 'string') {
      return output.ename;
    }
  }
  return undefined;
}

function isKeyboardInterrupt(
  observation: Extract<JupyterNbmodelExecutionObservation, { state: 'failed' }>
): boolean {
  return (
    observation.errorName === 'KeyboardInterrupt' ||
    observation.outputs.some((value) => {
      const output = asRecord(value);
      return output?.output_type === 'error' && output.ename === 'KeyboardInterrupt';
    })
  );
}

function isTerminal(
  observation: JupyterNbmodelExecutionObservation
): observation is Extract<
  JupyterNbmodelExecutionObservation,
  { state: 'completed' | 'failed' | 'cancelled' }
> {
  return (
    observation.state === 'completed' ||
    observation.state === 'failed' ||
    observation.state === 'cancelled'
  );
}

function outputsOf(observation: JupyterNbmodelExecutionObservation): unknown[] | undefined {
  return 'outputs' in observation ? observation.outputs : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readLimitedText(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
}

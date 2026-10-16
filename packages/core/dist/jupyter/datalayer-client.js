import { randomUUID } from 'node:crypto';
import { JupyterHttpConnection } from './http-connection.js';
import { JupyterDiagnosticError, jupyterDiagnostic } from './diagnostics.js';
class DatalayerProtocolError extends Error {
    httpStatus;
    rpcCode;
    constructor(message, httpStatus, rpcCode) {
        super(message);
        this.httpStatus = httpStatus;
        this.rpcCode = rpcCode;
    }
}
function id(value) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
        throw new Error('Invalid Jupyter resource ID');
    }
    return encodeURIComponent(value);
}
/** Existing remote RTC/nbmodel interfaces. Does not require a Jupyter MCP extension. */
export class DatalayerJupyterClient extends JupyterHttpConnection {
    nextId = 0;
    constructor(options) {
        // Complete Notebook/nbconvert responses may include Plotly's inline bundle.
        // This transport bound is separate from the much smaller model previews.
        super({ ...options, maxResponseBytes: options.maxResponseBytes ?? 8_000_000 });
    }
    async inspectJson(route) {
        try {
            const response = await this.response(route);
            if (!response.ok) {
                return {
                    state: response.status === 404 ? 'missing' : 'unverified',
                    httpStatus: response.status,
                    diagnostic: (await this.responseError(response, 'interface-inspection')).diagnostic,
                };
            }
            try {
                return {
                    state: 'available',
                    httpStatus: response.status,
                    data: JSON.parse(await this.responseText(response)),
                };
            }
            catch {
                return { state: 'incompatible', httpStatus: response.status,
                    diagnostic: { layer: 'schema', code: 'invalid_interface_response', message: 'Jupyter interface returned invalid JSON',
                        hint: 'Verify the remote extension and configured endpoint.', status: response.status } };
            }
        }
        catch (error) {
            return { state: 'unverified', diagnostic: jupyterDiagnostic(error) };
        }
    }
    async inspectRtc() {
        try {
            const response = await this.response('lab');
            if (!response.ok) {
                return { state: 'unverified', httpStatus: response.status,
                    diagnostic: (await this.responseError(response, 'rtc-inspection')).diagnostic };
            }
            const html = await this.responseText(response);
            const script = html.match(/<script\b(?=[^>]*\bid=(["'])jupyter-config-data\1)[^>]*>([\s\S]*?)<\/script>/i);
            const config = script ? JSON.parse(script[2]) : undefined;
            return {
                state: config?.disableRTC === false
                    ? 'configured'
                    : config?.disableRTC === true
                        ? 'disabled'
                        : 'unverified',
                httpStatus: response.status,
                ...(typeof config?.serverSideExecution === 'boolean'
                    ? { serverSideExecution: config.serverSideExecution }
                    : {}),
            };
        }
        catch (error) {
            return { state: 'unverified', diagnostic: error instanceof JupyterDiagnosticError ? error.diagnostic
                    : { layer: 'schema', code: 'invalid_rtc_config', phase: 'rtc-inspection', message: 'JupyterLab RTC configuration could not be parsed',
                        hint: 'Verify the remote JupyterLab configuration and compatible extension versions.' } };
        }
    }
    /** Authenticated reads only: no MCP request, document, kernel or execution is created. */
    async inspectConnection() {
        const server = await this.json('api');
        const version = server?.version;
        if (typeof version !== 'string' ||
            !/^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(version) ||
            version.length > 128) {
            throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_api_version', phase: 'api-version',
                message: 'Authenticated Jupyter API version could not be verified', hint: 'Verify that the configured endpoint is a Jupyter Server API.' });
        }
        // The installed nbmodel GET lists a queue without creating a client or task.
        // An unowned random ID avoids opening or inspecting any user's kernel.
        const probeKernel = randomUUID();
        const [queue, rtc, exported] = await Promise.all([
            this.inspectJson(`api/kernels/${probeKernel}/execute`),
            this.inspectRtc(),
            this.inspectJson('api/nbconvert'),
        ]);
        const queueData = queue.data;
        const formats = exported.data && typeof exported.data === 'object' && !Array.isArray(exported.data)
            ? Object.keys(exported.data).filter((name) => /^[A-Za-z0-9_-]{1,100}$/.test(name))
            : undefined;
        return {
            backend: 'datalayer',
            serverVersion: version,
            nbmodel: {
                state: queue.state !== 'available'
                    ? queue.state
                    : queueData?.kernel_id === probeKernel && Array.isArray(queueData.requests)
                        ? 'available'
                        : 'incompatible',
                ...(queue.httpStatus !== undefined ? { httpStatus: queue.httpStatus } : {}),
                ...(queue.diagnostic ? { diagnostic: queue.diagnostic } : {}),
            },
            rtc,
            nbconvert: {
                state: exported.state !== 'available'
                    ? exported.state
                    : formats?.includes('html')
                        ? 'available'
                        : 'incompatible',
                ...(exported.httpStatus !== undefined ? { httpStatus: exported.httpStatus } : {}),
                ...(formats ? { formats } : {}),
                ...(exported.diagnostic ? { diagnostic: exported.diagnostic } : {}),
            },
            productAcceptance: 'not_verified',
        };
    }
    async openDocument(path, expectedId) {
        const { JupyterRtcDocument } = await import('./rtc-document.js');
        return JupyterRtcDocument.open(this, path, expectedId);
    }
    notebookEntry(path) {
        return this.url(`lab/tree/${path.split('/').map(encodeURIComponent).join('/')}`).href;
    }
    fileEntry(path) {
        return this.url(`files/${path.split('/').map(encodeURIComponent).join('/')}`).href;
    }
    requestEntry(handle) {
        return this.url(`api/kernels/${id(handle.kernelId)}/requests/${id(handle.requestId)}`).href;
    }
    /** Follow a native file ID rather than a replacement at its old path. */
    async documentPath(documentId) {
        const data = (await this.json(`api/fileid/path?id=${id(documentId)}`));
        if (data?.id !== documentId || typeof data.path !== 'string') {
            throw new Error('Notebook stable path could not be verified');
        }
        const { notebookPath } = await import('./rtc-document.js');
        notebookPath(data.path);
        return data.path;
    }
    /** Standard kernel channels handshake; captures the process's native message session. */
    async kernelInfo(kernelId) {
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
            const finish = (value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                socket.close();
                if (value) {
                    resolve(value);
                }
                else {
                    reject(new Error('Remote Jupyter kernel readiness could not be verified'));
                }
            };
            const timer = setTimeout(() => finish(), 15000);
            socket.once('error', () => finish());
            socket.once('close', () => finish());
            socket.once('open', () => socket.send(JSON.stringify({
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
            })));
            socket.on('message', (buffer) => {
                try {
                    const message = JSON.parse(buffer.toString());
                    if (message.header?.msg_type === 'kernel_info_reply' &&
                        message.parent_header?.msg_id === messageId &&
                        typeof message.header.session === 'string' &&
                        message.header.session.length > 0 &&
                        message.header.session.length <= 256) {
                        finish({ kernelId, incarnation: message.header.session });
                    }
                }
                catch {
                    finish();
                }
            });
        });
    }
    /** Direct nbmodel queue submission preserves a recoverable request ID. Never retries. */
    async submitCell(kernelId, documentId, cellId, code, context) {
        const kernel = id(kernelId);
        id(documentId);
        id(cellId);
        if (!code || Buffer.byteLength(code) > 262144) {
            throw new Error('Invalid Notebook execution source');
        }
        let response;
        try {
            response = await this.response(`api/kernels/${kernel}/execute`, 'POST', {
                code,
                metadata: {
                    document_id: `json:notebook:${documentId}`,
                    cell_id: cellId,
                    ...(context
                        ? {
                            document_path: context.documentPath,
                            run_id: context.runId,
                            kernel_incarnation: context.kernelIncarnation,
                            allow_stdin: false,
                        }
                        : {}),
                },
            });
        }
        catch {
            return { state: 'unknown' };
        }
        await response.body?.cancel();
        if (response.status !== 202) {
            return {
                state: [400, 401, 403, 404, 405, 409, 413, 422, 429].includes(response.status)
                    ? 'rejected'
                    : 'unknown',
                httpStatus: response.status,
            };
        }
        const location = response.headers.get('location');
        try {
            const url = new URL(location ?? '', this.base);
            const match = url.pathname.match(/\/api\/kernels\/([^/]+)\/requests\/([A-Za-z0-9_-]{1,256})$/);
            if (!location ||
                url.origin !== this.base.origin ||
                url.username ||
                url.password ||
                url.search ||
                url.hash ||
                !match ||
                match[1] !== kernel ||
                url.pathname !== this.url(`api/kernels/${kernel}/requests/${match[2]}`).pathname) {
                return { state: 'unknown', httpStatus: 202 };
            }
            return {
                state: 'accepted',
                handle: {
                    kernelId,
                    requestId: match[2],
                    ...(context
                        ? {
                            requestLocation: url.pathname,
                            kernelIncarnation: context.kernelIncarnation,
                            serverInstanceId: context.serverInstanceId,
                        }
                        : {}),
                },
            };
        }
        catch {
            return { state: 'unknown', httpStatus: 202 };
        }
    }
    /** Read only the original request. Missing lookup never proves non-execution. */
    async observe(handle) {
        let responded = false;
        try {
            const response = await this.response(`api/kernels/${id(handle.kernelId)}/requests/${id(handle.requestId)}`);
            responded = true;
            if ([404, 410].includes(response.status)) {
                await response.body?.cancel();
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: {
                        kind: 'server-unknown',
                        reason: response.status === 410 ? 'request-expired' : 'request-not-found',
                    },
                };
            }
            if (![200, 202, 300, 500].includes(response.status)) {
                await response.body?.cancel();
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: {
                        kind: 'client-error',
                        reason: response.status === 401
                            ? 'authentication-required'
                            : response.status === 403
                                ? 'permission-denied'
                                : 'http-error',
                    },
                };
            }
            const result = JSON.parse(await this.responseText(response));
            if ((result.request_id !== undefined && result.request_id !== handle.requestId) ||
                (result.kernel_id !== undefined && result.kernel_id !== handle.kernelId)) {
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: { kind: 'client-error', reason: 'result-provenance-mismatch' },
                };
            }
            if (handle.kernelIncarnation &&
                result.kernel_incarnation !== undefined &&
                result.kernel_incarnation !== handle.kernelIncarnation) {
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: { kind: 'server-unknown', reason: 'kernel-incarnation-changed' },
                };
            }
            const artifact = result.result_artifact;
            if (artifact !== undefined &&
                artifact !== `nbmodel-results/${handle.kernelId}/${handle.requestId}.json`) {
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: { kind: 'client-error', reason: 'result-provenance-mismatch' },
                };
            }
            const entries = {
                original_result_entry: this.requestEntry(handle),
                ...(typeof artifact === 'string'
                    ? { result_artifact_entry: this.fileEntry(artifact) }
                    : {}),
            };
            if (response.status === 202) {
                return { state: 'running', httpStatus: 202, result: { ...result, ...entries } };
            }
            if (response.status === 300) {
                return { state: 'input_required', httpStatus: 300, result };
            }
            // 0.1.1a4 serializes outputs as a JSON string and returns kernel errors with HTTP 200.
            const outputs = typeof result.outputs === 'string'
                ? JSON.parse(result.outputs)
                : result.outputs;
            if (outputs !== undefined && !Array.isArray(outputs)) {
                return {
                    state: 'unknown',
                    httpStatus: response.status,
                    failure: { kind: 'client-error', reason: 'invalid-response' },
                };
            }
            const error = (result.error ??
                (Array.isArray(outputs) ? outputs.find((o) => o?.output_type === 'error') : undefined));
            if (response.status === 500 &&
                (typeof error !== 'object' || typeof error?.ename !== 'string')) {
                return {
                    state: 'unknown',
                    httpStatus: 500,
                    failure: { kind: 'client-error', reason: 'http-error' },
                };
            }
            const normalized = {
                ...result,
                ...entries,
                ...(outputs !== undefined ? { outputs } : {}),
                ...(error ? { error } : {}),
            };
            return {
                state: error?.ename === 'KeyboardInterrupt' || error?.ename === 'CancelledError'
                    ? 'cancelled'
                    : response.status === 500 || error || result.status === 'error'
                        ? 'failed'
                        : 'completed',
                httpStatus: response.status,
                result: normalized,
            };
        }
        catch (error) {
            return {
                state: 'unknown',
                failure: {
                    kind: 'client-error',
                    reason: responded
                        ? 'invalid-response'
                        : error instanceof Error &&
                            /authentication|credential|password|token/i.test(error.message)
                            ? 'authentication-required'
                            : 'connection-unavailable',
                },
            };
        }
    }
    /** Advertised queue policy is discovery, not proof that product acceptance passed. */
    async executionPolicy(kernelId = randomUUID()) {
        const inspected = await this.inspectJson(`api/kernels/${id(kernelId)}/execute`);
        const data = inspected.data;
        const policy = data?.execution_policy;
        if (inspected.state !== 'available' ||
            data?.kernel_id !== kernelId ||
            !Array.isArray(data.requests) ||
            policy?.schema !== 1 ||
            policy.terminal_gets !== 'non_consuming' ||
            policy.target_cancellation !== 'managed_pid_and_queue_owner' ||
            policy.native_incarnation !== true ||
            policy.source_provenance !== true ||
            policy.stdin_opt_out !== true ||
            typeof policy.server_instance_id !== 'string' ||
            !/^[A-Za-z0-9_-]{1,256}$/.test(policy.server_instance_id) ||
            typeof policy.result_retention_seconds !== 'number' ||
            !Number.isFinite(policy.result_retention_seconds) ||
            policy.result_retention_seconds <= 0 ||
            !Number.isSafeInteger(policy.request_quota) ||
            Number(policy.request_quota) < 1 ||
            !Number.isSafeInteger(policy.inline_result_bytes) ||
            Number(policy.inline_result_bytes) < 1024) {
            return undefined;
        }
        return {
            serverInstanceId: policy.server_instance_id,
            resultRetentionSeconds: policy.result_retention_seconds,
            requestQuota: Number(policy.request_quota),
            inlineResultBytes: Number(policy.inline_result_bytes),
        };
    }
    /** Explicit kernel-wide operation; never restart, create, retry or cancel a named run. */
    async interruptKernel(kernelId, signal) {
        const route = `api/kernels/${id(kernelId)}`;
        let phase = 'inspect_kernel';
        const result = (state, httpStatus) => ({
            kernelId,
            state,
            executionState: 'unknown',
            phase,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
        });
        const failure = (status) => result(status === 404
            ? 'missing'
            : [405, 501].includes(status)
                ? 'unsupported'
                : [401, 403].includes(status)
                    ? 'rejected'
                    : 'unknown', status);
        signal?.throwIfAborted();
        try {
            const inspected = await this.response(route);
            if (!inspected.ok) {
                await inspected.body?.cancel();
                return failure(inspected.status);
            }
            const model = JSON.parse(await this.responseText(inspected));
            if (!model || model.id !== kernelId) {
                return result('identity_changed', inspected.status);
            }
            // A busy kernel may not answer kernel_info until execution ends. The REST
            // identity check must not wait on that shell request before interrupting.
            signal?.throwIfAborted();
            phase = 'interrupt';
            const response = await this.response(`${route}/interrupt`, 'POST');
            await response.body?.cancel();
            return response.status === 204 ? result('accepted', 204) : failure(response.status);
        }
        catch {
            signal?.throwIfAborted();
            // The server may have received the POST. Do not send a second interrupt.
            return result('unknown');
        }
    }
    /** Require target cancellation policy before a DELETE; no kernel-wide fallback. */
    async stopRequest(handle) {
        try {
            const policy = await this.executionPolicy(handle.kernelId);
            if (!policy) {
                return 'unsupported';
            }
            if (handle.serverInstanceId && handle.serverInstanceId !== policy.serverInstanceId) {
                return 'unknown';
            }
            const response = await this.response(`api/kernels/${id(handle.kernelId)}/requests/${id(handle.requestId)}`, 'DELETE');
            await response.body?.cancel();
            return response.status === 204
                ? 'requested'
                : [405, 501].includes(response.status)
                    ? 'unsupported'
                    : 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    async rpc(method, params = {}) {
        const id = ++this.nextId;
        const response = await this.response('mcp', 'POST', { jsonrpc: '2.0', id, method, params });
        if (!response.ok) {
            await response.body?.cancel();
            throw new DatalayerProtocolError(`Datalayer MCP returned HTTP ${response.status}`, response.status);
        }
        const data = JSON.parse(await this.responseText(response));
        if (!data ||
            typeof data !== 'object' ||
            Array.isArray(data) ||
            data.jsonrpc !== '2.0' ||
            data.id !== id) {
            throw new DatalayerProtocolError('Datalayer MCP response identity mismatch');
        }
        if (data.error) {
            // Remote errors can reflect paths or credentials. Only a numeric protocol code is public.
            const error = data.error;
            const code = typeof error.code === 'number' && Number.isSafeInteger(error.code) ? error.code : undefined;
            throw new DatalayerProtocolError(`Datalayer MCP ${method} failed${code !== undefined ? ` (code ${code})` : ''}`, undefined, code);
        }
        return data.result;
    }
    async initialize() {
        return (await this.rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'disclaude-datalayer-mvp', version: '0.6.3' },
        }));
    }
    async listTools() {
        const result = (await this.rpc('tools/list'));
        if (!result ||
            !Array.isArray(result.tools) ||
            result.tools.length > 256 ||
            result.tools.some((tool) => !tool ||
                typeof tool.name !== 'string' ||
                !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(tool.name) ||
                !tool.inputSchema ||
                typeof tool.inputSchema !== 'object' ||
                Array.isArray(tool.inputSchema) ||
                tool.inputSchema.type !== 'object')) {
            throw new DatalayerProtocolError('Invalid Datalayer tool inventory');
        }
        return result.tools;
    }
    async callTool(name, arguments_) {
        const result = (await this.rpc('tools/call', {
            name,
            arguments: arguments_,
        }));
        if (!result || !Array.isArray(result.content)) {
            throw new Error('Invalid Datalayer tool response');
        }
        return result;
    }
    async json(route, method = 'GET', body) {
        const response = await this.response(route, method, body);
        if (!response.ok) {
            throw await this.responseError(response);
        }
        if (response.status === 204) {
            await response.body?.cancel();
            return undefined;
        }
        try {
            return JSON.parse(await this.responseText(response));
        }
        catch (error) {
            if (error instanceof JupyterDiagnosticError) {
                throw error;
            }
            throw new JupyterDiagnosticError({ layer: 'schema', code: 'invalid_json_response', phase: 'response', status: response.status,
                message: 'Jupyter API response is not valid JSON', hint: 'Verify the configured remote API endpoint and server extension versions.' });
        }
    }
}

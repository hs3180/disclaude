import { JupyterHttpConnection } from './http-connection.js';
export { createJupyterCookieJar } from './http-connection.js';
class CoordinatorHttpError extends Error {
    status;
    constructor(status, missingExtension = false) {
        super(missingExtension
            ? 'Jupyter coordinator extension is unavailable (HTTP 404)'
            : `Jupyter coordinator returned HTTP ${status}`);
        this.status = status;
    }
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Jupyter coordinator object');
    }
    return value;
}
function string(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Invalid Jupyter coordinator ${name}`);
    }
    return value;
}
function number(value, name) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid Jupyter coordinator ${name}`);
    }
    return value;
}
function lease(value) {
    const data = object(value);
    return {
        ownerId: string(data.ownerId, 'ownerId'),
        generation: number(data.generation, 'generation'),
    };
}
function sameNotebook(a, b) {
    return (a.identity.connectionId === b.identity.connectionId &&
        a.identity.serverNamespace === b.identity.serverNamespace &&
        a.identity.documentId === b.identity.documentId);
}
function locator(value) {
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
function snapshot(value, notebook, cellId) {
    const data = object(value);
    const resource = locator(data.notebook);
    if (!sameNotebook(resource, notebook) ||
        data.cellId !== cellId ||
        typeof data.source !== 'string') {
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
function executionTarget(value, notebook, runId) {
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
    };
}
function handle(value, notebook, runId) {
    return {
        ...executionTarget(value, notebook, runId),
        requestId: string(object(value).requestId, 'requestId'),
    };
}
function observation(value, notebook, runId) {
    const data = object(value);
    if (data.runId !== runId) {
        throw new Error('Execution observation runId mismatch');
    }
    if (data.state === 'not_started') {
        if (data.submissionFenced !== true || data.handle !== undefined) {
            throw new Error('Unsubmitted execution has no permanent submission fence');
        }
        return {
            state: 'not_started',
            runId,
            target: executionTarget(data.target, notebook, runId),
            submissionFenced: true,
        };
    }
    const current = data.handle ? handle(data.handle, notebook, runId) : undefined;
    if (data.state === 'unknown') {
        return { runId, state: 'unknown', handle: current, reason: string(data.reason, 'reason') };
    }
    if (!current) {
        throw new Error('Execution observation has no handle');
    }
    if ([
        'queued',
        'running',
        'input_required',
        'stopping',
        'completed',
        'failed',
        'cancelled',
    ].includes(String(data.state))) {
        return {
            runId,
            state: data.state,
            handle: current,
            details: data.details,
        };
    }
    throw new Error('Unknown Jupyter execution state');
}
function sameTarget(a, b) {
    return (sameNotebook(a.notebook, b.notebook) &&
        a.cellId === b.cellId &&
        a.expectedRevision === b.expectedRevision &&
        a.sourceHash === b.sourceHash &&
        a.kernelId === b.kernelId &&
        a.kernelIncarnation === b.kernelIncarnation &&
        a.runId === b.runId &&
        a.controller.ownerId === b.controller.ownerId &&
        a.controller.generation === b.controller.generation);
}
/** Node HTTP ports for the optional extension deployed in the remote Jupyter server. */
export class JupyterCoordinatorClient extends JupyterHttpConnection {
    options;
    namespace;
    connecting;
    connected = false;
    constructor(options) {
        super(options);
        this.options = options;
        string(options.connectionId, 'connectionId');
        this.namespace = options.serverNamespace;
    }
    async request(path, body) {
        const response = await this.send(`api/disclaude${path}`, body);
        if (!response.ok) {
            await response.body?.cancel();
            if ([401, 403].includes(response.status)) {
                this.connected = false;
            }
            throw new CoordinatorHttpError(response.status, path === '' && response.status === 404);
        }
        return JSON.parse(await this.responseText(response));
    }
    /** Host diagnostics only: no document, controller or kernel operations. */
    async inspectConnection() {
        await this.authenticate();
        const response = await this.send('api');
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error(`Jupyter version check returned HTTP ${response.status}`);
        }
        const data = object(JSON.parse(await this.responseText(response)));
        const serverVersion = string(data.version, 'server version');
        if (serverVersion.length > 100) {
            throw new Error('Invalid Jupyter server version');
        }
        try {
            return { serverVersion, coordinator: 'available', status: await this.connect() };
        }
        catch (error) {
            if (error instanceof CoordinatorHttpError && error.status === 404) {
                return { serverVersion, coordinator: 'missing' };
            }
            throw error;
        }
    }
    async connect() {
        this.connecting ??= this.loadStatus();
        const pending = this.connecting;
        try {
            return await pending;
        }
        finally {
            if (this.connecting === pending) {
                this.connecting = undefined;
            }
        }
    }
    async loadStatus() {
        this.connected = false;
        await this.authenticate();
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
        const status = {
            protocolVersion: 1,
            serverNamespace: namespace,
            stack: stack,
            activeRooms: number(data.activeRooms, 'activeRooms'),
            pendingRooms: number(data.pendingRooms, 'pendingRooms'),
            roomFailures: roomFailures,
            maxRooms: number(data.maxRooms, 'maxRooms'),
            idleSeconds: typeof data.idleSeconds === 'number' &&
                Number.isFinite(data.idleSeconds) &&
                data.idleSeconds >= 0
                ? data.idleSeconds
                : number(data.idleSeconds, 'idleSeconds'),
        };
        this.connected = true;
        return status;
    }
    async operation(notebook, name, fields = {}) {
        if (!this.connected) {
            await this.connect();
        }
        if (notebook.identity.connectionId !== this.options.connectionId ||
            notebook.identity.serverNamespace !== this.namespace) {
            throw new Error('Notebook does not belong to this Jupyter connection');
        }
        return this.request(`/notebooks/${encodeURIComponent(notebook.identity.documentId)}/${name}`, {
            notebook,
            ...fields,
        });
    }
    async openNotebook(contentPath) {
        if (!this.connected) {
            await this.connect();
        }
        const resource = locator(await this.request('/notebooks', { contentPath, connectionId: this.options.connectionId }));
        if (resource.identity.connectionId !== this.options.connectionId ||
            resource.identity.serverNamespace !== this.namespace) {
            throw new Error('Opened Notebook identity mismatch');
        }
        return resource;
    }
    async describeNotebook(notebook) {
        const data = object(await this.operation(notebook, 'describe'));
        const resource = locator(data.notebook);
        if (!sameNotebook(resource, notebook) ||
            !Array.isArray(data.cells) ||
            data.cells.length > 1024) {
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
    async claimControl(notebook, ownerId, expectedGeneration) {
        return lease(await this.operation(notebook, 'control', { ownerId, expectedGeneration }));
    }
    async currentController(notebook) {
        const result = await this.operation(notebook, 'control', { action: 'read' });
        return result === null ? null : lease(result);
    }
    async controlState(notebook) {
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
    async stopOwner(notebook, controller) {
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
        }
        catch {
            return { state: 'unknown', reason: 'Notebook owner stop outcome could not be verified' };
        }
    }
    /** Select a kernelspec and bind a kernel through the remote server API. */
    async ensureKernel(notebook, kernelName = 'python3') {
        const result = object(await this.operation(notebook, 'kernel', { kernelName }));
        return {
            kernelId: string(result.kernelId, 'kernelId'),
            kernelIncarnation: string(result.kernelIncarnation, 'kernelIncarnation'),
        };
    }
    async readCell(notebook, cellId) {
        return snapshot(await this.operation(notebook, 'read-cell', { cellId }), notebook, cellId);
    }
    async editCellSource(request) {
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
        }
        catch (error) {
            return {
                state: 'unknown',
                reason: error instanceof Error ? error.message : 'Jupyter edit outcome unknown',
            };
        }
    }
    async submit(request) {
        try {
            const data = object(await this.operation(request.target.notebook, 'submit', {
                target: request.target,
                source: request.source,
            }));
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
        }
        catch (error) {
            // No network or parse error authorizes a second POST. Reconcile runId.
            return {
                state: 'unknown',
                runId: request.target.runId,
                reason: error instanceof Error ? error.message : 'Jupyter submission outcome unknown',
            };
        }
    }
    async getStatus(notebook, runId) {
        try {
            return observation(await this.operation(notebook, 'status', { runId }), notebook, runId);
        }
        catch (error) {
            return {
                runId,
                state: 'unknown',
                reason: error instanceof Error ? error.message : 'Jupyter observation unavailable',
            };
        }
    }
    async reconcileSubmission(target) {
        try {
            const data = object(await this.operation(target.notebook, 'fence-submission', { target }));
            if (data.state === 'not_started') {
                const proof = observation(data, target.notebook, target.runId);
                if (proof.state !== 'not_started' || !sameTarget(proof.target, target)) {
                    throw new Error('Submission fence target mismatch');
                }
                return proof;
            }
            if (data.state === 'recorded') {
                const current = observation(data.observation, target.notebook, target.runId);
                if (!current.handle || !sameTarget(current.handle, target)) {
                    throw new Error('Recorded execution target mismatch');
                }
                return { state: 'recorded', observation: current };
            }
            if (data.state === 'ownership_lost') {
                return {
                    state: 'ownership_lost',
                    currentGeneration: number(data.currentGeneration, 'currentGeneration'),
                };
            }
            if (data.state === 'unknown' && data.runId === target.runId) {
                return { state: 'unknown', runId: target.runId, reason: string(data.reason, 'reason') };
            }
            throw new Error('Unknown submission reconciliation outcome');
        }
        catch {
            return {
                state: 'unknown',
                runId: target.runId,
                reason: 'Submission reconciliation could not be verified; do not replay',
            };
        }
    }
    async stop(execution, controller) {
        try {
            const data = object(await this.operation(execution.notebook, 'stop', { handle: execution, controller }));
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
        }
        catch (error) {
            return {
                state: 'unknown',
                reason: error instanceof Error ? error.message : 'Jupyter stop outcome unknown',
            };
        }
    }
}

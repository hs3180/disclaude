import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
/**
 * Jupyter-owned configuration at `<workingDir>/.jupyter/config.json`.
 *
 * The caller supplies the active working directory. This store knows nothing
 * about chat bindings or ProjectManager and holds no cached configuration.
 * Each operation reads the file so other instances and manual edits are visible.
 */
export class JupyterProjectConfigStore {
    configPath;
    constructor(workingDir) {
        if (!workingDir.trim()) {
            throw new Error('Jupyter configuration requires a working directory');
        }
        this.configPath = resolve(workingDir, '.jupyter', 'config.json');
    }
    listNotebookReferences() {
        const loaded = this.load();
        return loaded.ok ? { ok: true, data: loaded.data.notebooks } : loaded;
    }
    /** Update by stable document identity, or by service-scoped path if unresolved. */
    linkNotebook(reference) {
        const error = validateReference(reference);
        if (error) {
            return { ok: false, error };
        }
        const loaded = this.load();
        if (!loaded.ok) {
            return loaded;
        }
        const sanitized = cloneReference(reference);
        const key = referenceKey(sanitized);
        const references = loaded.data.notebooks;
        const index = references.findIndex((item) => referenceKey(item) === key);
        if (index === -1) {
            references.push(sanitized);
        }
        else {
            references[index] = sanitized;
        }
        const saved = this.persist(loaded.data);
        return saved.ok ? { ok: true, data: sanitized } : saved;
    }
    /** Replace an unresolved path only while its original reference still matches. */
    resolveNotebook(reference, documentId) {
        const resolved = { ...reference, documentId };
        const error = validateReference(resolved);
        if (error) {
            return { ok: false, error };
        }
        const loaded = this.load();
        if (!loaded.ok) {
            return loaded;
        }
        const index = loaded.data.notebooks.findIndex((item) => referenceKey(item) === referenceKey(reference));
        const existing = loaded.data.notebooks[index];
        if (!existing || existing.contentPath !== reference.contentPath) {
            return { ok: false, error: 'Notebook reference changed while resolving its identity' };
        }
        if (reference.documentId && reference.documentId !== documentId) {
            return { ok: false, error: 'Notebook stable identity changed' };
        }
        const current = cloneReference({ ...existing, documentId });
        loaded.data.notebooks[index] = current;
        loaded.data.notebooks = loaded.data.notebooks.filter((item, position) => position === index || referenceKey(item) !== referenceKey(current));
        const saved = this.persist(loaded.data);
        return saved.ok ? { ok: true, data: current } : saved;
    }
    /** Update only the path of the original, still-authorized stable document. */
    updateNotebookPath(reference, contentPath) {
        if (!reference.documentId) {
            return { ok: false, error: 'A stable document ID is required to follow a rename' };
        }
        const next = { ...reference, contentPath };
        const error = validateReference(next);
        if (error) {
            return { ok: false, error };
        }
        const loaded = this.load();
        if (!loaded.ok) {
            return loaded;
        }
        const index = loaded.data.notebooks.findIndex((item) => referenceKey(item) === referenceKey(reference));
        if (index < 0 || loaded.data.notebooks[index].contentPath !== reference.contentPath) {
            return { ok: false, error: 'Notebook reference changed while following its identity' };
        }
        const current = cloneReference({ ...loaded.data.notebooks[index], contentPath });
        loaded.data.notebooks[index] = current;
        const saved = this.persist(loaded.data);
        return saved.ok ? { ok: true, data: current } : saved;
    }
    /** Remove only the local reference; never delete a notebook or stop a kernel. */
    unlinkNotebook(reference) {
        const error = validateReference(reference);
        if (error) {
            return { ok: false, error };
        }
        const loaded = this.load();
        if (!loaded.ok) {
            return loaded;
        }
        const key = referenceKey(reference);
        const references = loaded.data.notebooks;
        const remaining = references.filter((item) => referenceKey(item) !== key);
        if (remaining.length === references.length) {
            return { ok: true, data: false };
        }
        const saved = this.persist({ version: 1, notebooks: remaining });
        return saved.ok ? { ok: true, data: true } : saved;
    }
    load() {
        let raw;
        try {
            raw = fs.readFileSync(this.configPath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return { ok: true, data: { version: 1, notebooks: [] } };
            }
            return { ok: false, error: `Failed to read ${this.configPath}: ${errorMessage(error)}` };
        }
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new Error('expected a Jupyter configuration object');
            }
            const config = parsed;
            if (config.version !== 1 || !Array.isArray(config.notebooks)) {
                throw new Error('expected version 1 and a notebooks array');
            }
            const notebooks = [];
            for (const entry of config.notebooks) {
                const error = validateReference(entry);
                if (error) {
                    throw new Error(error);
                }
                notebooks.push(cloneReference(entry));
            }
            return { ok: true, data: { version: 1, notebooks } };
        }
        catch (error) {
            // A malformed or unsupported file must not be replaced with an empty list.
            return { ok: false, error: `Invalid ${this.configPath}: ${errorMessage(error)}` };
        }
    }
    persist(config) {
        const temporaryPath = `${this.configPath}.${randomUUID()}.tmp`;
        let created = false;
        try {
            fs.mkdirSync(dirname(this.configPath), { recursive: true });
            const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            created = true;
            try {
                fs.writeFileSync(descriptor, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
            }
            finally {
                fs.closeSync(descriptor);
            }
            fs.renameSync(temporaryPath, this.configPath);
            return { ok: true, data: undefined };
        }
        catch (error) {
            return { ok: false, error: `Failed to save ${this.configPath}: ${errorMessage(error)}` };
        }
        finally {
            if (created) {
                try {
                    fs.unlinkSync(temporaryPath);
                }
                catch {
                    // The successful rename already removed it, or cleanup failed.
                }
            }
        }
    }
}
function validateReference(reference) {
    if (typeof reference !== 'object' || reference === null || Array.isArray(reference)) {
        return 'Jupyter notebook reference must be an object';
    }
    const candidate = reference;
    if (!isOpaqueIdentifier(candidate.connectionId, 200)) {
        return 'Jupyter connectionId is required and must be a trimmed identifier';
    }
    if (!isOpaqueIdentifier(candidate.serverNamespace, 200)) {
        return 'Jupyter serverNamespace is required and must be a trimmed identifier';
    }
    if (typeof candidate.contentPath !== 'string' ||
        candidate.contentPath.length === 0 ||
        candidate.contentPath.length > 1024 ||
        candidate.contentPath !== candidate.contentPath.trim() ||
        candidate.contentPath.startsWith('/') ||
        candidate.contentPath.endsWith('/') ||
        candidate.contentPath.includes('\\') ||
        candidate.contentPath.includes('\0') ||
        !candidate.contentPath.toLowerCase().endsWith('.ipynb') ||
        candidate.contentPath
            .split('/')
            .some((segment) => !segment || segment === '.' || segment === '..')) {
        return 'Jupyter contentPath must be a relative .ipynb path without traversal segments';
    }
    if (candidate.documentId !== undefined && !isOpaqueIdentifier(candidate.documentId, 500)) {
        return 'Jupyter documentId must be a trimmed identifier when provided';
    }
    if (candidate.lastKnownVersion !== undefined &&
        !isOpaqueIdentifier(candidate.lastKnownVersion, 1000)) {
        return 'Jupyter lastKnownVersion must be a trimmed identifier when provided';
    }
    return null;
}
function isOpaqueIdentifier(value, maxLength) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        value === value.trim() &&
        !value.includes('://') &&
        !/[?#]/.test(value) &&
        !/[\u0000-\u001f\u007f]/.test(value));
}
function cloneReference(reference) {
    return {
        connectionId: reference.connectionId,
        serverNamespace: reference.serverNamespace,
        ...(reference.documentId !== undefined ? { documentId: reference.documentId } : {}),
        contentPath: reference.contentPath,
        ...(reference.lastKnownVersion !== undefined
            ? { lastKnownVersion: reference.lastKnownVersion }
            : {}),
    };
}
function referenceKey(reference) {
    const identity = reference.documentId
        ? `document:${reference.documentId}`
        : `path:${reference.contentPath}`;
    return `${reference.connectionId}\0${reference.serverNamespace}\0${identity}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
/** Retain machine-owned fields only, never transcript content or error bodies. */
export function apiErrorEvidence(value) {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const row = value;
    const status = row.apiErrorStatus;
    const transient = row.apiErrorIsTransient;
    if ((typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599)
        || typeof transient === 'boolean') {
        return { ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? { apiErrorStatus: status } : {}),
            ...(typeof transient === 'boolean' ? { apiErrorIsTransient: transient } : {}) };
    }
    return undefined;
}
/** An append cursor for the main-session ID observed from the SDK stream. */
export class ClaudeTranscriptErrors {
    path;
    session;
    offset = 0;
    inode;
    pending = '';
    skippingLine = false;
    configDir;
    since;
    decoder = new StringDecoder('utf8');
    reset() {
        this.path = undefined;
        this.session = undefined;
        this.offset = 0;
        this.inode = undefined;
        this.pending = '';
        this.skippingLine = false;
        this.configDir = undefined;
        this.since = undefined;
        this.decoder = new StringDecoder('utf8');
    }
    /** SDK init owns the session ID; inspect only that filename under its local store. */
    bindSession(session, configDir, since) {
        if (this.session || !/^[a-zA-Z0-9_-]{1,128}$/.test(session) || !isAbsolute(configDir)) {
            return;
        }
        this.session = session;
        this.configDir = configDir;
        this.since = since;
    }
    /** The SDK can publish its terminal before the local transcript write settles. */
    async readAfterFlush(expectError, stopped) {
        const deadline = Date.now() + 500;
        for (;;) {
            const result = await this.read();
            if (!this.session || result.error || (!expectError && result.state === 'available')
                || stopped() || Date.now() >= deadline) {
                return result;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    async findSessionFile() {
        if (this.path || !this.configDir || !this.session) {
            return;
        }
        const projects = join(this.configDir, 'projects');
        const matches = [];
        for (const entry of await readdir(projects, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const path = join(projects, entry.name, `${this.session}.jsonl`);
            try {
                if ((await stat(path)).isFile()) {
                    matches.push(path);
                }
            }
            catch { /* No matching session here. */ }
        }
        // An ambiguous identity cannot safely be attributed to this query.
        if (matches.length === 1) {
            [this.path] = matches;
        }
    }
    async read() {
        let file;
        try {
            await this.findSessionFile();
            if (!this.path) {
                return { state: 'unavailable' };
            }
            file = await open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            const info = await file.stat();
            if (!info.isFile() || info.size < this.offset || (this.inode !== undefined && this.inode !== info.ino)) {
                this.reset();
                return { state: 'unavailable' };
            }
            this.inode = info.ino;
            let error;
            if (info.size > this.offset) {
                const stream = file.createReadStream({ start: this.offset, end: info.size - 1, autoClose: false });
                for await (const chunk of stream) {
                    const bytes = chunk;
                    this.offset += bytes.length;
                    const text = this.decoder.write(bytes);
                    const lines = (this.pending + text).split('\n');
                    this.pending = lines.pop() ?? '';
                    for (const line of lines) {
                        if (this.skippingLine) {
                            this.skippingLine = false;
                            continue;
                        }
                        if (line.length > 262_144) {
                            continue;
                        }
                        let row;
                        try {
                            row = JSON.parse(line);
                        }
                        catch {
                            continue;
                        }
                        if (!row || typeof row !== 'object' || (row.sessionId ?? row.session_id) !== this.session) {
                            continue;
                        }
                        if (row.isSidechain === true) {
                            continue;
                        }
                        if (this.since !== undefined && (typeof row.timestamp !== 'string' || !(Date.parse(row.timestamp) >= this.since))) {
                            continue;
                        }
                        const message = row.message && typeof row.message === 'object' ? row.message : undefined;
                        if (row.isApiErrorMessage === true || message?.isApiErrorMessage === true) {
                            error = apiErrorEvidence(row) ?? apiErrorEvidence(message);
                        }
                        else if (row.type === 'assistant' && message?.content) {
                            // A later ordinary assistant response means the API error recovered.
                            error = undefined;
                        }
                    }
                    if (this.pending.length > 262_144) {
                        this.pending = '';
                        this.skippingLine = true;
                    }
                }
            }
            return { state: 'available', ...(error ? { error } : {}) };
        }
        catch {
            return { state: 'unavailable' };
        }
        finally {
            await file?.close().catch(() => { });
        }
    }
}

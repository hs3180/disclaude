import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
function cells(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length || Object.keys(value).length > 20 ||
        Object.entries(value).some(([key, cell]) => !text(key, 512) || !(typeof cell === 'string' ? cell.length <= 16000 :
            Array.isArray(cell) && cell.length <= 100 && cell.every(item => text(item, 4000))))) {
        throw new Error('Invalid task board cells');
    }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Projection only, never the atomic claim authority. Fixed record/identity,
 * patch-only writes and a private durable intent prevent blind resends after
 * an unknown remote ACK. The host authorizes each current effect.
 */
export class TaskBoardProjection {
    port;
    authorize;
    binding;
    directory;
    constructor(directory, binding, port, authorize) {
        this.port = port;
        this.authorize = authorize;
        if (!isAbsolute(directory) || !text(binding.key, 2048) || !text(binding.recordId, 512) || !binding.writable.length ||
            binding.writable.some(field => !text(field, 512) || Object.hasOwn(binding.required, field)) ||
            new Set(binding.writable).size !== binding.writable.length) {
            throw new Error('Invalid fixed task board binding');
        }
        cells(binding.required);
        this.binding = structuredClone(binding);
        this.directory = resolve(directory);
    }
    async read() {
        const record = await this.port.read();
        if (record.recordId !== this.binding.recordId || !record.fields || typeof record.fields !== 'object' ||
            Object.entries(this.binding.required).some(([field, expected]) => !equal(record.fields[field], expected))) {
            throw new Error('Task board record, Goal or acceptance criteria changed');
        }
        return record;
    }
    async ensure(input) {
        cells(input);
        const desired = structuredClone(input);
        if (Object.keys(desired).some(field => !this.binding.writable.includes(field))) {
            throw new Error('Task board field is not writable');
        }
        const matches = (record) => Object.entries(desired).every(([field, expected]) => equal(record.fields[field], expected));
        await this.authorize();
        const before = await this.read();
        if (matches(before)) {
            return before;
        }
        // The fingerprint includes every fixed identity and desired cell. Reordering
        // object keys cannot turn an uncertain write into a new attempt.
        const sorted = (value) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
        const key = createHash('sha256').update(JSON.stringify([this.binding.key, this.binding.recordId, sorted(this.binding.required), sorted(desired)])).digest('hex');
        if (!await this.begin(key)) {
            throw new Error('Task board write acknowledgement needs reconciliation; no patch was resent');
        }
        await this.authorize();
        const latest = await this.read();
        if (matches(latest)) {
            return latest;
        }
        await this.authorize();
        try {
            await this.port.patch(desired);
        }
        catch { /* The remote write may have committed. Read its actual state. */ }
        await this.authorize();
        const after = await this.read();
        if (!matches(after)) {
            throw new Error('Task board projection is not confirmed; reconcile the original record');
        }
        return after;
    }
    async begin(key) {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (!(await fs.lstat(this.directory)).isDirectory()) {
            throw new Error('Task board intent storage must be a real directory');
        }
        await fs.chmod(this.directory, 0o700);
        const marker = join(this.directory, key);
        let fresh = false;
        try {
            await fs.mkdir(marker, { mode: 0o700 });
            fresh = true;
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
        }
        if (!(await fs.lstat(marker)).isDirectory()) {
            throw new Error('Task board write intent is redirected');
        }
        const handle = await fs.open(this.directory, constants.O_RDONLY);
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        return fresh;
    }
}

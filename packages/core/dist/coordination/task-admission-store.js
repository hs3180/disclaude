import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
const writes = new Map();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const text = (value) => typeof value === 'string' && !!value.trim() && value.length <= 2048;
function fields(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !allowed.includes(key))) {
        throw new Error('Invalid task admission fields');
    }
}
function validate(value, key) {
    fields(value, ['version', 'key', 'fingerprint', 'claim', 'phase', 'nativeId']);
    fields(value.claim, ['key', 'revision', 'owner', 'claimId']);
    if (value.version !== 1 || value.key !== key || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
        !text(value.claim.key) || !Number.isSafeInteger(value.claim.revision) || value.claim.revision < 1 ||
        !uuid(value.claim.owner) || !uuid(value.claim.claimId) || !['prepared', 'dispatching', 'admitted'].includes(value.phase) ||
        (value.phase === 'admitted' ? !uuid(value.nativeId) : value.nativeId !== undefined)) {
        throw new Error('Invalid task admission record');
    }
}
/** One owning service saves claim credentials BEFORE claim/projection RPCs, and
 * dispatch intent BEFORE starting native work. This stores no authority and
 * never starts, retries, releases or expires work. The host fingerprints the
 * complete fixed source, task, criteria and route; operationId alone is unsafe.
 */
export class TaskAdmissionStore {
    directory;
    constructor(directory) {
        if (!isAbsolute(directory)) {
            throw new Error('Task admission storage must be absolute');
        }
        this.directory = resolve(directory);
    }
    file(key) {
        if (!text(key)) {
            throw new Error('Invalid task admission key');
        }
        return join(this.directory, `${hash(key)}.json`);
    }
    async get(key) {
        const file = this.file(key);
        try {
            if (!(await fs.lstat(this.directory)).isDirectory()) {
                throw new Error();
            }
            const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > 16384) {
                    throw new Error();
                }
                const value = JSON.parse(await handle.readFile('utf8'));
                validate(value, key);
                return value;
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return undefined;
            }
            throw new Error('Cannot read task admission; preserve and privately restore its storage');
        }
    }
    /** An identical operation retains its ORIGINAL lease even if the current
     * claim revision advanced while the first acknowledgement was lost.
     */
    prepare(key, fingerprint, claimKey, expectedClaimRevision) {
        if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || !text(claimKey) || !Number.isSafeInteger(expectedClaimRevision) ||
            expectedClaimRevision < 0 || expectedClaimRevision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('Invalid task admission plan');
        }
        return this.serialize(key, async () => {
            const previous = await this.get(key);
            if (previous) {
                if (previous.fingerprint !== fingerprint || previous.claim.key !== claimKey) {
                    throw new Error('Task admission already belongs to different work');
                }
                await this.syncDirectory();
                return previous;
            }
            const record = { version: 1, key, fingerprint,
                claim: { key: claimKey, revision: expectedClaimRevision + 1, owner: randomUUID(), claimId: randomUUID() }, phase: 'prepared' };
            await this.save(record, true);
            return structuredClone(record);
        });
    }
    async beginDispatch(key) {
        return await this.serialize(key, async () => {
            const previous = await this.get(key);
            if (!previous) {
                throw new Error('Task admission not found');
            }
            if (previous.phase !== 'prepared') {
                await this.syncDirectory();
                return { record: previous, dispatch: false };
            }
            const record = { ...previous, phase: 'dispatching' };
            await this.save(record, false);
            return { record, dispatch: true };
        });
    }
    /** Supply only the actual returned native handle ID, never a guessed ID.
     * Admitted means start returned a handle, not execution success/settlement.
     */
    async confirmDispatch(key, nativeId) {
        if (!uuid(nativeId)) {
            throw new Error('Invalid native admission receipt');
        }
        return await this.serialize(key, async () => {
            const previous = await this.get(key);
            if (!previous || previous.phase === 'prepared') {
                throw new Error('No native dispatch intent to confirm');
            }
            if (previous.phase === 'admitted') {
                if (previous.nativeId !== nativeId) {
                    throw new Error('Task admission already has another native receipt');
                }
                await this.syncDirectory();
                return previous;
            }
            const record = { ...previous, phase: 'admitted', nativeId };
            await this.save(record, false);
            return structuredClone(record);
        });
    }
    async serialize(key, operation) {
        this.file(key);
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        if (!(await fs.lstat(this.directory)).isDirectory()) {
            throw new Error('Task admission storage must be a real directory');
        }
        await fs.chmod(this.directory, 0o700);
        const file = join(await fs.realpath(this.directory), `${hash(key)}.json`);
        const work = (writes.get(file) ?? Promise.resolve()).then(operation), settled = work.then(() => { }, () => { });
        writes.set(file, settled);
        void settled.then(() => { if (writes.get(file) === settled) {
            writes.delete(file);
        } });
        return await work;
    }
    async syncDirectory() {
        const handle = await fs.open(this.directory, constants.O_RDONLY);
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    async save(record, exclusive) {
        const staging = join(this.directory, `.${randomUUID()}.tmp`), handle = await fs.open(staging, 'wx', 0o600);
        try {
            await handle.writeFile(JSON.stringify(record));
            await handle.sync();
            await handle.close();
            if (exclusive) {
                await fs.link(staging, this.file(record.key));
            }
            else {
                await fs.rename(staging, this.file(record.key));
            }
            await this.syncDirectory();
        }
        finally {
            await handle.close().catch(() => { });
            await fs.rm(staging, { force: true }).catch(() => { });
        }
    }
}

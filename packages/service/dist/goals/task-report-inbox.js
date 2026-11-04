import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const digest = (value) => createHash('sha256').update(value).digest('hex');
function artifacts(value) {
    if (!plain(value) || Object.keys(value).some(key => !['summary', 'refs'].includes(key)) || !text(value.summary, 16000) ||
        !Array.isArray(value.refs) || value.refs.length < 1 || value.refs.length > 100 ||
        value.refs.some(ref => !text(ref, 2048)) || new Set(value.refs).size !== value.refs.length) {
        throw new Error('Invalid artifact proposal');
    }
    value.refs = [...value.refs].sort();
}
function review(value) {
    if (!plain(value) || Object.keys(value).some(key => !['verdict', 'reason', 'evidence'].includes(key)) ||
        !['changes-requested', 'approved'].includes(value.verdict) || !text(value.reason, 16000) ||
        !Array.isArray(value.evidence) || value.evidence.length > 100) {
        throw new Error('Invalid review proposal');
    }
    const seen = new Set();
    for (const item of value.evidence) {
        if (!plain(item) || Object.keys(item).some(key => !['criterion', 'note'].includes(key)) ||
            !Number.isSafeInteger(item.criterion) || item.criterion < 0 || seen.has(item.criterion) ||
            !text(item.note, 4000)) {
            throw new Error('Invalid review evidence');
        }
        seen.add(item.criterion);
    }
    // Criterion upper bounds and full approval coverage are enforced by the
    // owning host, which knows the actual acceptance criteria count.
    value.evidence = [...value.evidence].sort((a, b) => a.criterion - b.criterion);
}
function validate(kind, value) {
    if (!plain(value)) {
        throw new Error('Invalid task report payload');
    }
    if (kind === 'artifacts') {
        artifacts(value);
    }
    else {
        review(value);
    }
    return structuredClone(value);
}
const receiptName = (receipt) => `receipt-${digest(JSON.stringify([receipt.kind, receipt.payload]))}.json`;
/** Append one proposal receipt to an operation-owned inbox. Identical
 * redelivery is idempotent; a different payload under the same inbox is a
 * poisoned operation the owner must reconcile with a new operation ID.
 */
export async function writeTaskReport(directory, kind, payload) {
    if (!isAbsolute(directory)) {
        throw new Error('Task report inbox must be an absolute path');
    }
    const receipt = { kind, payload: validate(kind, payload) };
    const inbox = resolve(directory);
    await fs.mkdir(inbox, { recursive: true, mode: 0o700 });
    if (!(await fs.lstat(inbox)).isDirectory()) {
        throw new Error('Task report inbox must be a real directory');
    }
    await fs.chmod(inbox, 0o700);
    const name = receiptName(receipt);
    const staging = join(inbox, `.${randomUUID()}.tmp`);
    const data = JSON.stringify({ version: 1, at: new Date().toISOString(), ...receipt });
    try {
        const handle = await fs.open(staging, 'wx', 0o600);
        try {
            await handle.writeFile(data);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        try {
            await fs.link(staging, join(inbox, name));
        }
        catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }
            // An identical earlier delivery is an acknowledged retry, not a conflict.
            const known = await readTaskReports(inbox);
            if (!known.some(entry => entry.kind === kind && digest(JSON.stringify(entry.payload)) === digest(JSON.stringify(receipt.payload)))) {
                throw new Error('Task report inbox already holds a different proposal; retry with a new operation');
            }
        }
        const dir = await fs.open(inbox, constants.O_RDONLY);
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
        return name;
    }
    finally {
        await fs.rm(staging, { force: true }).catch(() => { });
    }
}
/** Read every receipt in an operation inbox, rejecting anything that is not a
 * valid receipt: the inbox belongs to exactly one settled operation.
 */
export async function readTaskReports(directory) {
    if (!isAbsolute(directory)) {
        throw new Error('Task report inbox must be an absolute path');
    }
    const inbox = resolve(directory);
    let entries;
    try {
        entries = await fs.readdir(inbox);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    // Dot-prefixed entries are this module's own transient staging files; every
    // other entry must be a valid receipt, because the inbox belongs to one
    // settled operation.
    const names = entries.filter(name => name !== '.' && name !== '..' && !name.startsWith('.'));
    if (!names.every(name => /^receipt-[0-9a-f]{64}\.json$/.test(name)) || names.length > 32) {
        throw new Error('Task report inbox holds unexpected entries');
    }
    const receipts = [];
    for (const name of names) {
        try {
            const handle = await fs.open(join(inbox, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size > 64 * 1024) {
                    throw new Error('Invalid task report receipt');
                }
                const value = JSON.parse(await handle.readFile('utf8'));
                if (!plain(value) || Object.keys(value).some(key => !['version', 'kind', 'at', 'payload'].includes(key)) ||
                    value.version !== 1 || !text(value.at, 64) || !Number.isFinite(Date.parse(value.at))) {
                    throw new Error('Invalid task report receipt');
                }
                const kind = value.kind;
                if (!['artifacts', 'review'].includes(kind)) {
                    throw new Error('Invalid task report receipt');
                }
                const payload = validate(kind, value.payload);
                if (receiptName({ kind, payload }) !== name) {
                    throw new Error('Invalid task report receipt');
                }
                receipts.push({ kind, at: value.at, payload });
            }
            finally {
                await handle.close();
            }
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                continue;
            }
            throw error instanceof Error && error.message === 'Invalid task report receipt' ? error
                : new Error('Invalid task report receipt');
        }
    }
    return receipts;
}
/** An operation inbox belongs to exactly one settled child of one kind. Zero
 * or several distinct proposals — or any receipt of a foreign kind — is a
 * poisoned operation that needs a new operation ID, never a silent pick.
 */
export async function readSingleTaskReport(directory, kind) {
    const receipts = await readTaskReports(directory);
    if (receipts.some(receipt => receipt.kind !== kind)) {
        throw new Error('Task report inbox holds a foreign proposal kind');
    }
    const distinct = new Set(receipts.map(receipt => digest(JSON.stringify(receipt.payload))));
    if (distinct.size > 1) {
        throw new Error('Task report inbox holds conflicting proposals');
    }
    const [receipt] = receipts;
    if (!receipt) {
        throw new Error(`Task report inbox has no ${kind} proposal`);
    }
    return structuredClone(receipt.payload);
}

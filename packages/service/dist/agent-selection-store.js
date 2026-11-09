/** Durable per-chat agent selections recorded by `/agent use` (#5476). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
function validSelection(value, chatId) {
    return value !== null && typeof value === 'object' && value.chatId === chatId
        && typeof value.presetName === 'string' && !!value.presetName.trim()
        && typeof value.updatedBy === 'string' && !!value.updatedBy.trim()
        && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}
/**
 * Synchronous, owner-only and atomic so pool lookup stays synchronous per
 * message. Persisted as `<workspace>/.disclaude/agent-selections.json`; a
 * corrupt or unreadable document is fatal at startup instead of silently
 * dropping the users' saved switches.
 */
export class AgentSelectionStore {
    filePath;
    selections;
    constructor(filePath) {
        this.filePath = filePath;
        let document = { version: 1, selections: {} };
        try {
            if (statSync(filePath).size > 1024 * 1024) {
                throw new Error('too large');
            }
            chmodSync(filePath, 0o600);
            document = JSON.parse(readFileSync(filePath, 'utf8'));
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error(`Cannot read agent selections at ${filePath}`);
            }
        }
        if (document.version !== 1 || !document.selections || typeof document.selections !== 'object'
            || Array.isArray(document.selections)
            || !Object.entries(document.selections).every(([chatId, selection]) => validSelection(selection, chatId))) {
            throw new Error(`Invalid agent selections at ${filePath}`);
        }
        this.selections = document.selections;
    }
    get(chatId) {
        const selection = this.selections[chatId];
        return selection ? { ...selection } : undefined;
    }
    set(chatId, presetName, actorId) {
        const previous = this.selections[chatId];
        const selection = { chatId, presetName, updatedBy: actorId, updatedAt: new Date().toISOString() };
        this.selections[chatId] = selection;
        try {
            this.write();
        }
        catch (error) {
            if (previous) {
                this.selections[chatId] = previous;
            }
            else {
                delete this.selections[chatId];
            }
            throw error;
        }
        return { ...selection };
    }
    write() {
        mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temp = `${dirname(this.filePath)}/.${randomUUID()}.tmp`;
        try {
            writeFileSync(temp, JSON.stringify({ version: 1, selections: this.selections }), { mode: 0o600, flag: 'wx' });
            renameSync(temp, this.filePath);
        }
        finally {
            rmSync(temp, { force: true });
        }
    }
}

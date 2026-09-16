import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AgentFactory } from '../agents/factory.js';
export class TaskDirectoryError extends Error {
    constructor() { super('Task working directory is missing or inaccessible'); }
}
/**
 * Run one bounded agent turn in an existing project directory. Returns the typed
 * final text without assuming a domain, stage sequence or JSON result schema.
 * The caller owns persistence, publication and deciding whether to continue.
 * dispose requests cancellation; this API does not prove OS descendants exited.
 */
export async function runTaskTurn(request) {
    // Freeze bindings for this attempt even if its caller later switches projects.
    const input = { ...request };
    if (input.signal.aborted) {
        throw new Error('Task turn interrupted');
    }
    if (!input.identity || !input.owner || !Number.isSafeInteger(input.timeoutMs)
        || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) {
        throw new Error('Task turn requires an identity, owner and valid time budget');
    }
    try {
        if (!isAbsolute(input.workingDir) || !statSync(input.workingDir).isDirectory()) {
            throw new TaskDirectoryError();
        }
    }
    catch {
        throw new TaskDirectoryError();
    }
    let completed;
    const agent = AgentFactory.createAgent(input.identity, {
        sendMessage: () => Promise.resolve(),
        onTurnResult: result => { completed = result; return Promise.resolve(); },
        sendCard: () => Promise.reject(new Error('Task publication belongs to the project controller')),
        sendFile: () => Promise.reject(new Error('Task publication belongs to the project controller')),
    }, { sdkSessionKey: input.identity, skipHistory: true, cwdProvider: () => input.workingDir });
    let rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const abort = () => rejectStop(new Error('Task turn interrupted'));
    input.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => rejectStop(new Error('Task turn time budget exhausted')), input.timeoutMs);
    timer.unref();
    try {
        // Factory/setup code can trigger cancellation before the listener is attached.
        if (input.signal.aborted) {
            throw new Error('Task turn interrupted');
        }
        await Promise.race([
            agent.runOnce(input.identity, input.prompt, input.identity, input.owner),
            stopped,
        ]);
        if (input.signal.aborted) {
            throw new Error('Task turn interrupted');
        }
        if (!completed?.success || completed.truncated) {
            throw new Error('Task turn did not finish successfully');
        }
        return completed.text;
    }
    finally {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', abort);
        // Attach before disposal, which can synchronously settle/reject runtime work.
        void stopped.catch(() => { });
        agent.dispose();
    }
}

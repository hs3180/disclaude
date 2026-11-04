import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { buildSessionKey, sanitizeDiagnosticText } from "../../../core/dist/index.js";
import { AgentFactory } from './factory.js';
import { ownAsyncCallbacks } from './async-callback-ownership.js';
const requiredText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const failureText = (error) => sanitizeDiagnosticText(error instanceof Error ? error.message : 'Agent task failed without an error message').slice(0, 2000);
/** Explicit independent executions; no Goal, board, scheduling or automatic retries.
 * The host owns authorization and real delivery callbacks. Each task captures its
 * directory and runtime, skips chat history and receives a unique native identity.
 */
export class AgentTaskRunner {
    agentOptions;
    runs = new Map();
    closing = false;
    closeFlight;
    constructor(agentOptions = {}) {
        this.agentOptions = agentOptions;
    }
    get activeCount() { return this.runs.size; }
    start(request, callbacks) {
        if (this.closing) {
            throw new Error('Agent task runner is closing');
        }
        if (!requiredText(request.task, 64_000) || !requiredText(request.workingDirectory, 4096)
            || !isAbsolute(request.workingDirectory)
            || !requiredText(request.chatId, 512) || !requiredText(request.sourceMessageId, 512)
            || !requiredText(request.senderOpenId, 512)
            || (request.chatType !== undefined && !['p2p', 'group', 'topic'].includes(request.chatType))
            || (request.threadRootId !== undefined && !requiredText(request.threadRootId, 512))
            || (request.replyRootId !== undefined && request.replyRootId !== null && !requiredText(request.replyRootId, 512))) {
            throw new Error('Invalid agent task or trusted source context');
        }
        const input = structuredClone(request);
        const directory = realpathSync(input.workingDirectory);
        if (!statSync(directory).isDirectory()) {
            throw new Error('Agent task working directory must exist');
        }
        const id = randomUUID();
        let lastResult;
        let resultFailed = false;
        let resultTruncated = false;
        const ownedCallbacks = ownAsyncCallbacks({
            ...callbacks,
            onTurnResult: async (result) => {
                lastResult = { ...result };
                resultFailed ||= !result.success || result.truncated;
                resultTruncated ||= result.truncated;
                await callbacks.onTurnResult?.(result);
            },
        });
        const agent = AgentFactory.createAgent(input.chatId, ownedCallbacks.callbacks, {
            ...this.agentOptions,
            skipHistory: true,
            sdkSessionKey: buildSessionKey(input.chatId, `task:${id}`),
            cwdProvider: () => directory,
            cwdResolver: () => {
                let available = false;
                try {
                    available = statSync(directory).isDirectory();
                }
                catch { /* no workspace fallback */ }
                return { effectiveCwd: directory, boundWorkingDir: directory, reason: available ? 'bound' : 'bound-missing' };
            },
        });
        let stopped = false;
        let settled = false;
        let stopError;
        const stop = () => {
            if (stopped || settled) {
                return;
            }
            stopped = true;
            try {
                agent.dispose();
            }
            catch (error) {
                stopError = error;
            }
        };
        const completion = Promise.resolve().then(async () => {
            let executionError;
            try {
                if (stopped) {
                    throw new Error('Agent task stopped before admission');
                }
                await agent.processMessage({ chatId: input.chatId, payload: input.task,
                    messageId: input.sourceMessageId, senderOpenId: input.senderOpenId,
                    ...(input.chatType ? { chatType: input.chatType } : {}),
                    ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
                    ...(input.replyRootId !== undefined ? { replyRootId: input.replyRootId } : {}),
                });
                const done = agent.turnCompleteFor(input.sourceMessageId);
                if (!done) {
                    throw new Error('Agent task was not admitted to a native turn');
                }
                await done;
            }
            catch (error) {
                executionError = error;
            }
            // A failed parent result does not release still-owned background work.
            try {
                await agent.waitForWorkSettlement();
            }
            catch (error) {
                executionError ??= error;
            }
            let disposalError;
            try {
                agent.dispose();
            }
            catch (error) {
                disposalError = error;
                executionError ??= error;
            }
            // Dispose rejects turn waiters promptly, but the iterator and RPC-side
            // callbacks can still own channel requests. Join both before releasing.
            await agent.waitForQueryExit();
            await ownedCallbacks.settle();
            if (!lastResult || resultFailed) {
                executionError ??= new Error('Agent task has no successful complete result');
            }
            const outcome = { id, outcome: disposalError ? 'failed' : stopped ? 'stopped' : executionError ? 'failed' : 'succeeded',
                text: lastResult?.text ?? '', truncated: resultTruncated,
                ...(executionError || stopError ? { error: failureText(disposalError ?? stopError ?? executionError) } : {}),
            };
            settled = true;
            this.runs.delete(id);
            return outcome;
        });
        const handle = Object.freeze({ id, completion, stop });
        this.runs.set(id, handle);
        return handle;
    }
    /** Stop owned tasks and retain their handles until cleanup returns. */
    close() {
        this.closing = true;
        this.closeFlight ??= (async () => {
            const handles = [...this.runs.values()];
            for (const handle of handles) {
                handle.stop();
            }
            await Promise.all(handles.map(handle => handle.completion));
        })();
        return this.closeFlight;
    }
}

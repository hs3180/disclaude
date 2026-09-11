/**
 * DeepSeek harness provider contract (Issue #4741).
 *
 * Drives the official dsh SDK profile over newline-delimited JSON-RPC.
 */
import { existsSync } from 'node:fs';
import { createLogger } from '../../../utils/logger.js';
import { DshSessionPool } from './dsh-session-pool.js';
import { adaptDeepSeekEvent } from './event-adapter.js';
const logger = createLogger('DeepSeekHarnessProvider');
export class DeepSeekHarnessProvider {
    name = 'deepseek';
    version = '0.0.0-harness-preview';
    env;
    apiKey;
    dshHome;
    disposed = false;
    sessionKeys = new Map();
    queues = new Map();
    pool;
    constructor(options = {}) {
        this.env = options.env ?? process.env;
        this.apiKey = options.apiKey ?? this.env.DEEPSEEK_API_KEY;
        this.dshHome = options.dshHome ?? this.env.DSH_HOME;
        const transportOptions = {
            binary: options.binary,
            args: options.args,
            requestTimeoutMs: options.requestTimeoutMs,
            env: { ...process.env, ...this.env, DEEPSEEK_API_KEY: this.apiKey, DSH_HOME: this.dshHome },
            onNotification: (notification) => this.onNotification(notification),
            onProtocolError: (error, line) => logger.warn({ err: error, line }, 'Invalid dsh protocol frame'),
        };
        this.pool = new DshSessionPool(transportOptions);
    }
    getInfo() {
        const available = this.validateConfig();
        return {
            name: this.name,
            version: this.version,
            available,
            ...(available ? {} : { unavailableReason: this.diagnose() }),
        };
    }
    queryStream(input, options) {
        if (this.disposed) {
            throw new Error('DeepSeekHarnessProvider has been disposed');
        }
        const reason = this.diagnose();
        if (reason) {
            throw new Error(`DeepSeekHarnessProvider unavailable: ${reason}`);
        }
        if (options.mcpServers || options.allowedTools || options.disallowedTools || options.tools) {
            throw new Error('DeepSeek Harness SDK protocol 0.1.2 does not support client tool registration or tool allow/deny filters; configure tools in the dsh sdk profile');
        }
        // SDK 0.1.2 creates durable sessions but exposes no resume/load method.
        // Each new process needs a fresh native ID, even for the same logical chat.
        // Multi-turn context remains in the input stream's one live session.
        const sessionId = `disclaude-${crypto.randomUUID()}`;
        this.sessionKeys.set(sessionId, options.sessionKey ?? sessionId);
        const transport = this.pool.getOrCreate(sessionId);
        const abort = new AbortController();
        let wake = () => { };
        const state = {
            events: [],
            wake: () => wake(),
            abort,
            pendingText: '',
        };
        this.queues.set(sessionId, state);
        let inputDone = false;
        let accepted = 0;
        let terminal = 0;
        let failure;
        const { signal } = abort;
        const pump = (async () => {
            try {
                await transport.request('initialize', {
                    cwd: options.cwd ?? process.cwd(),
                    provider: 'deepseek-official',
                    model: options.model ?? 'deepseek-official',
                }, signal);
                for await (const message of input) {
                    const contentBlocks = typeof message.content === 'string'
                        ? [{ type: 'text', text: message.content }]
                        : message.content.map((block) => block.type === 'text'
                            ? { type: 'text', text: block.text }
                            : { type: 'image', data: block.data, mimeType: block.mimeType });
                    await transport.request('session/prompt', { sessionId, contentBlocks }, signal);
                    accepted++;
                }
            }
            catch (error) {
                if (!signal.aborted) {
                    const detail = error instanceof Error ? error.message : String(error);
                    failure = new Error(`dsh SDK process failed during initialize/prompt: ${detail}`);
                }
            }
            finally {
                inputDone = true;
                state.wake();
            }
        })();
        const provider = this;
        const iterator = (async function* () {
            try {
                for (;;) {
                    while (state.events.length) {
                        const event = state.events.shift();
                        if (!event) {
                            continue;
                        }
                        if (event.type === 'result' || event.type === 'error') {
                            terminal++;
                        }
                        yield event;
                    }
                    if (failure) {
                        throw failure;
                    }
                    if (signal.aborted || (inputDone && terminal >= accepted)) {
                        break;
                    }
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
                }
                if (!signal.aborted) {
                    await pump;
                }
            }
            finally {
                provider.queues.delete(sessionId);
                provider.sessionKeys.delete(sessionId);
                if (!signal.aborted) {
                    await transport.shutdown().catch((error) => {
                        logger.warn({ err: error, sessionId }, 'dsh graceful shutdown failed');
                    });
                }
                provider.pool.release(sessionId);
            }
        })();
        const close = () => {
            if (!signal.aborted) {
                abort.abort();
            }
            void input.return(undefined);
            state.wake();
            this.pool.release(sessionId);
        };
        return { handle: { close, cancel: close, sessionId }, iterator };
    }
    createInlineTool(_definition) {
        throw new Error('DeepSeek Harness SDK protocol 0.1.2 has no inline-tool registration method; configure tools in the dsh sdk profile');
    }
    createMcpServer(_config) {
        throw new Error('DeepSeekHarnessProvider: MCP mapping is not supported by the preview.');
    }
    validateConfig() {
        // dsh can read the key from its credentials service; an environment key is
        // optional and is forwarded when supplied.
        return !this.disposed && this.hasDshHome();
    }
    dispose() {
        this.disposed = true;
        this.pool.close();
        for (const state of this.queues.values()) {
            state.abort.abort();
            state.wake();
        }
        this.queues.clear();
        this.sessionKeys.clear();
    }
    forgetSession(sessionKey) {
        for (const [sessionId, key] of this.sessionKeys) {
            if (key === sessionKey) {
                this.pool.release(sessionId);
            }
        }
    }
    hasDshHome() {
        return !this.dshHome || existsSync(this.dshHome);
    }
    diagnose() {
        if (this.dshHome && !existsSync(this.dshHome)) {
            return `DSH_HOME does not exist: ${this.dshHome}`;
        }
        return '';
    }
    onNotification(notification) {
        if (notification.method !== 'session.event') {
            return;
        }
        const params = notification.params;
        if (typeof params?.sessionId !== 'string' || !params.event) {
            return;
        }
        const state = this.queues.get(params.sessionId);
        if (!state) {
            return;
        }
        if (params.event.type === 'assistant/chunk') {
            const chunk = params.event.data?.chunk;
            if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
                state.pendingText += chunk.text;
            }
            return;
        }
        if (params.event.type === 'assistant/message') {
            state.pendingText = '';
        }
        if (params.event.type === 'turn/end' && state.pendingText) {
            state.events.push({ type: 'text', content: state.pendingText, role: 'assistant' });
            state.pendingText = '';
        }
        state.events.push(...adaptDeepSeekEvent(params.event));
        state.wake();
    }
}

/**
 * On-demand research document comment watch session (T-089 rework / #5197,
 * review 6677596913).
 *
 * The maintainer direction: research doc comment monitoring must NOT run
 * automatically — it makes disclaude too heavy. Instead the disclaude CLI
 * offers a watch command so an agent can listen on demand. This module is the
 * service-side session host:
 *
 * - NOTHING is constructed or scheduled until `start()` — when no session is
 *   running there is no monitor object and no timer (zero resident cost).
 * - A session runs the bounded `DocCommentMonitor` loop over the explicit
 *   registration registry (`.disclaude/research-doc-watch/`), so only
 *   documents a Research context deliberately associated with a Project chat
 *   are ever polled, and only while a session is live.
 * - Session semantics live on the checkpoint (`state.json`): cursor/baseline,
 *   processed-id dedup across poll overlap and session restarts, per-doc
 *   exponential backoff with jitter, and explicit error reports (logger plus a
 *   bounded `recentErrors` ring surfaced through `status()`).
 * - Registration (`register`/`unregister`) is independent of the session: the
 *   association record is a file the agent or operator can manage at any
 *   time; a live session picks changes up on its next tick.
 * - Delivery routes each new comment batch into the ORIGINAL Project chat's
 *   agent as a system message (see `createResearchCommentDelivery`). The
 *   watcher never edits documents, replies to comments, or answers — adoption,
 *   follow-up questions and reasoned rejection stay with the research agent
 *   per the research-workflow skill (revision + commenter-notify methods).
 */
import { randomUUID } from 'node:crypto';
import { createLogger, } from "../../../core/dist/index.js";
import { ResearchDocWatchRegistry, } from './doc-watch-registry.js';
import { createLarkCliDocCommentSource } from './feishu-doc-comment-source.js';
import { DocCommentMonitor, buildResearchCommentNotificationMessage, } from './doc-comment-monitor.js';
const logger = createLogger('ResearchCommentWatch');
/** Bound on the error ring kept for `status()` — explicit, not unbounded. */
const RECENT_ERRORS_LIMIT = 20;
/** Default doc type when a registration omits it (only `docx` is exercised). */
const DEFAULT_DOC_TYPE = 'docx';
/**
 * Host of the on-demand research comment watch session. Constructing this
 * object is inert; polling exists only between `start()` and `stop()`.
 */
export class ResearchCommentWatchService {
    registry;
    options;
    monitor;
    startedAtMs;
    recentErrors = [];
    constructor(options) {
        this.options = options;
        this.registry = new ResearchDocWatchRegistry({
            watchDir: options.watchDir,
            ...(options.maxRegistrations !== undefined ? { maxRegistrations: options.maxRegistrations } : {}),
        });
    }
    /**
     * Start (or confirm) a watch session. Idempotent: when a session is already
     * running nothing changes and `started` is false.
     */
    async start(session) {
        if (this.monitor?.isRunning()) {
            return { started: false, status: await this.status() };
        }
        const monitor = new DocCommentMonitor({
            registry: this.registry,
            source: this.options.source ?? createLarkCliDocCommentSource(),
            deliver: this.options.deliver,
            onError: report => {
                this.recentErrors.push(report);
                if (this.recentErrors.length > RECENT_ERRORS_LIMIT) {
                    this.recentErrors.shift();
                }
            },
            watchDir: this.options.watchDir,
            pollIntervalMs: session?.pollIntervalMs ?? this.options.pollIntervalMs,
            ...(this.options.now ? { now: this.options.now } : {}),
        });
        this.recentErrors = [];
        this.startedAtMs = (this.options.now ?? (() => Date.now()))();
        monitor.start();
        this.monitor = monitor;
        logger.info({ startedAtMs: this.startedAtMs }, 'Research comment watch session started');
        return { started: true, status: await this.status() };
    }
    /** Stop the session. Registrations and the checkpoint stay on disk. */
    async stop() {
        const { monitor } = this;
        if (monitor) {
            await monitor.stop();
            // Keep the (stopped) monitor so status() still reports its last
            // checkpoint snapshot; a future start() builds a fresh monitor that
            // reloads state.json and resumes from that checkpoint.
        }
        logger.info('Research comment watch session stopped');
        return await this.status();
    }
    /** Whether a session loop is currently running. */
    isRunning() {
        return this.monitor?.isRunning() ?? false;
    }
    /**
     * Session + checkpoint + error report. Registry read is on demand; with no
     * session ever started this touches only the registration directory.
     */
    async status() {
        const registrations = await this.registry.list();
        const docs = {};
        const monitorState = this.monitor?.getStatus();
        if (monitorState) {
            for (const [token, state] of Object.entries(monitorState.docs)) {
                docs[token] = {
                    baselineDone: state.baselineDone,
                    processedComments: state.processedIds.length,
                    consecutiveFailures: state.consecutiveFailures,
                    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
                    ...(state.nextAttemptAtMs !== undefined ? { backoffUntilMs: state.nextAttemptAtMs } : {}),
                };
            }
        }
        return {
            running: monitorState?.running ?? false,
            ...(this.startedAtMs !== undefined ? { startedAtMs: this.startedAtMs } : {}),
            ...(monitorState?.pollIntervalMs !== undefined ? { pollIntervalMs: monitorState.pollIntervalMs } : {}),
            registrations,
            docs,
            recentErrors: [...this.recentErrors],
        };
    }
    /** Upsert the document → Project association. Validated by the registry. */
    async register(input) {
        if (input.identity !== undefined && input.identity !== 'user' && input.identity !== 'bot') {
            return { ok: false, error: 'identity 必须是 user 或 bot' };
        }
        const nowMs = (this.options.now ?? (() => Date.now()))();
        const entry = {
            docToken: input.docToken,
            docType: input.docType && input.docType.length > 0 ? input.docType : DEFAULT_DOC_TYPE,
            chatId: input.chatId,
            ...(input.projectName !== undefined ? { projectName: input.projectName } : {}),
            ...(input.registeredBy !== undefined ? { registeredBy: input.registeredBy } : {}),
            registeredAt: new Date(nowMs).toISOString(),
            identity: input.identity ?? 'user',
        };
        return await this.registry.register(entry);
    }
    /** Remove an association; a live session drops the document on its next tick. */
    async unregister(docToken) {
        return { removed: await this.registry.unregister(docToken) };
    }
}
/**
 * Delivery sink that routes each new comment batch to the ORIGINAL Project
 * chat's agent as a system message. The router is resolved lazily per delivery
 * (cli-main.ts initializes it after service start). `waitForCompletion` makes
 * the monitor advance the checkpoint only after the agent turn really
 * finished, so a crash between routing and processing redelivers the batch.
 */
export function createResearchCommentDelivery(getRouter) {
    return async (notification) => {
        const router = getRouter();
        if (!router) {
            throw new Error('InputMessageRouter not initialized; research comment notification deferred to the next poll');
        }
        const systemMessage = {
            id: `research-comment-${randomUUID()}`,
            replyRootId: null,
            source: 'system',
            trigger: 'command',
            payload: buildResearchCommentNotificationMessage(notification),
            chatId: notification.chatId,
            data: {
                monitor: notification.monitor,
                docToken: notification.docToken,
                commentIds: notification.comments.map(comment => comment.commentId),
            },
            createdAt: new Date().toISOString(),
            waitForCompletion: true,
        };
        await router.route(systemMessage);
    };
}

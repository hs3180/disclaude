/** Unified message delivery through the ordinary ChatAgent pool. */
import { createLogger } from "../../../core/dist/index.js";
const defaultLogger = createLogger('AgentPoolHandler');
const AGENT_CREATION_FAILED_MESSAGE = '⚠️ Agent 创建失败，请发送 /reset 重试。';
/** User and system messages share creation, processing, settlement and cleanup. */
export class AgentPoolMessageHandler {
    agentPool;
    callbacksFactory;
    log;
    constructor(options) {
        this.agentPool = options.agentPool;
        this.callbacksFactory = options.callbacksFactory;
        this.log = options.logger ?? defaultLogger;
    }
    handleUserMessage(params) {
        return this.dispatch(params, 'user message');
    }
    handleSystemMessage(chatId, payload, messageId, options) {
        return this.dispatch({ chatId, payload, messageId, ...(options?.agentSession ? { agentSession: options.agentSession } : {}) }, 'system message', options?.waitForCompletion);
    }
    dispatch(params, context, waitForCompletion = false) {
        const { chatId, messageId, threadRootId, agentSession } = params;
        if (agentSession?.releaseAfterTurn && !this.agentPool.releaseChatAgent) {
            return Promise.reject(new Error('Temporary agent session cleanup is not wired'));
        }
        this.log.info({ chatId, messageId, waitForCompletion }, `Handling ${context} via agent pool`);
        const agent = this.getAgentSafely(chatId, messageId, context, threadRootId, agentSession);
        if (!agent) {
            return waitForCompletion
                ? Promise.reject(new Error('ChatAgent creation failed — system message not processed'))
                : Promise.resolve();
        }
        const completion = this.processTurn(agent, params, waitForCompletion);
        if (waitForCompletion) {
            return completion.catch(err => {
                this.log.error({ err, chatId, messageId }, 'Agent processMessage or turnComplete failed for system message (waitForCompletion)');
                throw err;
            });
        }
        void completion.catch(err => {
            this.log.error({ err, chatId, messageId }, `Agent processMessage failed for ${context}`);
        });
        return Promise.resolve();
    }
    async processTurn(agent, params, waitForCompletion) {
        const { agentSession, ...message } = params;
        try {
            await agent.processMessage(message);
            if (waitForCompletion || agentSession?.releaseAfterTurn) {
                // Pin settlement to this message even when another input arrives first.
                const done = agent.turnCompleteFor(params.messageId);
                if (!done) {
                    throw new Error('Agent turn never started — message was not processed (no active session channel)');
                }
                await done;
            }
        }
        finally {
            // A caller's timeout never settles this promise or releases a running turn.
            if (agentSession?.releaseAfterTurn) {
                this.agentPool.releaseChatAgent?.(params.chatId, agentSession.id, agent);
            }
        }
    }
    getAgentSafely(chatId, messageId, context, threadRootId, session) {
        const callbacks = this.callbacksFactory(chatId);
        try {
            return session
                ? this.agentPool.getOrCreateChatAgent(chatId, callbacks, threadRootId, session)
                : this.agentPool.getOrCreateChatAgent(chatId, callbacks, threadRootId);
        }
        catch (err) {
            this.log.error({ err, chatId, messageId }, `Failed to create/get ChatAgent for ${context}`);
            void callbacks.sendMessage(chatId, AGENT_CREATION_FAILED_MESSAGE, messageId).catch(() => { });
            return null;
        }
    }
}

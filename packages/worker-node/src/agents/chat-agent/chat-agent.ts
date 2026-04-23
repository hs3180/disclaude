/**
 * ChatAgent - Platform-agnostic direct chat abstraction with Streaming Input.
 *
 * Issue #644: Complete isolation between chat sessions.
 * Issue #2345 Phase 3: Extracted ChatHistoryLoader and AgentLoopManager.
 *
 * Delegates to: ChatHistoryLoader, AgentLoopManager, ConversationOrchestrator,
 * RestartManager, MessageBuilder.
 */

import { Config, BaseAgent, MessageBuilder, ConversationOrchestrator, RestartManager, type StreamingUserMessage, type ChatAgent as ChatAgentInterface, type AgentUserInput, type AgentMessage, type MessageData, type CwdProvider } from '@disclaude/core';
import type { ChatAgentCallbacks, ChatAgentConfig } from './types.js';
import { ChatHistoryLoader } from './chat-history-loader.js';
import { AgentLoopManager } from './agent-loop-manager.js';

type UserInput = AgentUserInput;

/** Issue #644: Each ChatAgent instance is bound to a single chatId. */
export class ChatAgent extends BaseAgent implements ChatAgentInterface {
  readonly type = 'chat' as const;
  readonly name = 'ChatAgent';
  private readonly boundChatId: string;
  private readonly callbacks: ChatAgentCallbacks;
  private readonly cwdProvider?: CwdProvider;

  // Managers for separated concerns
  private readonly conversationOrchestrator: ConversationOrchestrator;
  private readonly restartManager: RestartManager;
  private readonly messageBuilder: MessageBuilder;
  private readonly historyLoader: ChatHistoryLoader;
  private readonly loopManager: AgentLoopManager;

  constructor(config: ChatAgentConfig) {
    super(config);

    this.boundChatId = config.chatId;
    this.callbacks = config.callbacks;
    this.cwdProvider = config.cwdProvider;

    this.conversationOrchestrator = new ConversationOrchestrator({ logger: this.logger });
    this.restartManager = new RestartManager({
      logger: this.logger,
      maxRestarts: 3,
      initialBackoffMs: 5000,
      maxBackoffMs: 60000,
    });
    this.messageBuilder = new MessageBuilder(config.messageBuilderOptions);
    this.historyLoader = new ChatHistoryLoader(this.boundChatId, this.logger);

    this.loopManager = new AgentLoopManager({
      chatId: this.boundChatId,
      callbacks: this.callbacks,
      historyLoader: this.historyLoader,
      conversationOrchestrator: this.conversationOrchestrator,
      restartManager: this.restartManager,
      logger: this.logger,
      createSdkOptions: (opts) => this.createSdkOptions(opts),
      createQueryStream: (gen, opts) => this.createQueryStream(gen, opts),
      cwdProvider: this.cwdProvider,
    });

    this.logger.info({ chatId: this.boundChatId }, 'ChatAgent created for chatId');
  }

  protected getAgentName(): string { return 'ChatAgent'; }
  getChatId(): string { return this.boundChatId; }

  start(): Promise<void> {
    this.logger.debug({ chatId: this.boundChatId }, 'ChatAgent start() called - session is created on-demand');
    return Promise.resolve();
  }

  /** Handle streaming user input and yield responses. */
  async *handleInput(input: AsyncGenerator<UserInput>): AsyncGenerator<AgentMessage> {
    for await (const userInput of input) {
      const chatId = userInput.metadata?.chatId ?? 'default';
      const messageId = userInput.metadata?.parentMessageId ?? `msg-${Date.now()}`;
      const senderOpenId = userInput.metadata?.fileRefs?.[0]?.name;

      if (chatId !== this.boundChatId) {
        this.logger.warn({ boundChatId: this.boundChatId, receivedChatId: chatId }, 'Received message for different chatId, ignoring');
        continue;
      }

      this.conversationOrchestrator.setThreadRoot(chatId, messageId);

      // Start session if needed
      if (!this.loopManager.isActive()) {
        this.loopManager.startLoop();
      }

      const capabilities = this.callbacks.getCapabilities?.(chatId);
      const enhancedContent = this.messageBuilder.buildEnhancedContent({
        text: userInput.content, messageId, senderOpenId,
      }, chatId, capabilities);

      const streamingMessage: StreamingUserMessage = {
        type: 'user',
        message: { role: 'user', content: enhancedContent },
        parent_tool_use_id: null,
        session_id: '',
      };

      // Push message with retry logic (Issue #2007)
      if (!this.loopManager.tryPushMessage(streamingMessage, chatId, messageId)) {
        if (!this.loopManager.isActive()) {
          this.logger.info({ chatId, messageId }, 'handleInput: session is not active, skipping retry');
          yield { content: '⚠️ 当前会话已重置，请直接发送新消息。', role: 'assistant', messageType: 'text' };
          continue;
        }

        // Cancel old query and restart
        const qh = this.loopManager.getQueryHandle();
        if (qh) {
          this.logger.info({ chatId }, 'handleInput: cancelling old queryHandle before retry');
          qh.cancel();
          this.loopManager.clearQueryHandle();
        }

        this.logger.warn({ chatId, messageId }, 'handleInput: first push failed, attempting session restart');
        try { this.loopManager.startLoop(); } catch (restartErr) {
          this.logger.error({ err: restartErr, chatId, messageId }, 'handleInput: session restart failed');
        }
        if (!this.loopManager.tryPushMessage(streamingMessage, chatId, messageId)) {
          this.logger.error({ chatId, messageId }, 'handleInput: retry also failed, yielding error');
          yield { content: '⚠️ 消息未能送达，会话已结束。请发送 /reset 重置会话后重试。', role: 'assistant', messageType: 'text' };
          continue;
        }
      }

      yield { content: '✓', role: 'assistant', messageType: 'notification' };
    }
  }

  /** Execute a one-shot query (CLI mode). Blocking — waits for completion. */
  async executeOnce(chatId: string, text: string, messageId?: string, senderOpenId?: string): Promise<void> {
    if (chatId !== this.boundChatId) {
      this.logger.error({ boundChatId: this.boundChatId, receivedChatId: chatId }, 'executeOnce called with wrong chatId');
      throw new Error(`ChatAgent bound to ${this.boundChatId} cannot execute for ${chatId}`);
    }

    this.logger.info({ chatId, messageId, textLength: text.length }, 'CLI mode: executing one-shot query');

    // Build MCP servers (CLI mode — no channel MCP server)
    const mcpServers: Record<string, unknown> = {};
    const configuredMcpServers = Config.getMcpServersConfig();
    if (configuredMcpServers) {
      for (const [name, config] of Object.entries(configuredMcpServers)) {
        mcpServers[name] = { type: 'stdio', command: config.command, args: config.args || [], ...(config.env && { env: config.env }) };
      }
    }

    const sdkOptions = this.createSdkOptions({ disallowedTools: ['EnterPlanMode'], mcpServers });
    const capabilities = this.callbacks.getCapabilities?.(chatId);
    const enhancedContent = this.messageBuilder.buildEnhancedContent({
      text, messageId: messageId ?? `cli-${Date.now()}`, senderOpenId,
    }, chatId, capabilities);

    this.logger.info({ chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}) }, 'Starting CLI query with direct prompt');

    try {
      for await (const { parsed } of this.queryOnce(enhancedContent, sdkOptions)) {
        if (parsed.type === 'result') {
          this.logger.debug({ chatId, content: parsed.content }, 'CLI query result received, breaking loop');
          break;
        }
        if (parsed.content) {
          await this.callbacks.sendMessage(chatId, parsed.content, messageId);
        }
      }
      this.logger.info({ chatId }, 'CLI query completed normally');
    } catch (error) {
      const err = error as Error;
      this.logger.error({ err, chatId, errorMessage: err.message }, 'CLI query error');
      await this.callbacks.sendMessage(chatId, `❌ Session error: ${err.message}`, messageId);
      throw err;
    }
  }

  /** Process a message. Non-blocking — pushes to channel and returns. Issue #1230: first-message history. */
  async processMessage(
    chatId: string, text: string, messageId: string, senderOpenId?: string,
    attachments?: MessageData['attachments'], chatHistoryContext?: string,
  ): Promise<void> {
    if (chatId !== this.boundChatId) {
      this.logger.error({ boundChatId: this.boundChatId, receivedChatId: chatId }, 'processMessage called with wrong chatId');
      return;
    }

    this.logger.info(
      { chatId, messageId, textLength: text.length, hasAttachments: !!attachments, hasChatHistory: !!chatHistoryContext },
      'processMessage called',
    );

    this.conversationOrchestrator.setThreadRoot(chatId, messageId);

    if (!this.loopManager.isActive()) {
      this.logger.info({ chatId }, 'No active session, starting agent loop');
      this.loopManager.startLoop();
    }

    // Issue #1863: Wait for first message history before building content
    if (!this.historyLoader.isFirstMessageHistoryLoaded()) {
      await this.historyLoader.loadFirstMessageHistory(this.callbacks);
    }

    // Issue #1230: Attach chat history on first message
    let effectiveChatHistoryContext = chatHistoryContext;
    if (!chatHistoryContext) {
      const firstMsgCtx = this.historyLoader.consumeFirstMessageContext();
      if (firstMsgCtx) {
        effectiveChatHistoryContext = firstMsgCtx;
        this.logger.info({ chatId, messageId, historyLength: firstMsgCtx.length }, 'Using pre-loaded chat history for first message');
      }
    }

    const capabilities = this.callbacks.getCapabilities?.(chatId);
    const enhancedContent = this.messageBuilder.buildEnhancedContent({
      text, messageId, senderOpenId, attachments,
      chatHistoryContext: effectiveChatHistoryContext,
      persistedHistoryContext: this.historyLoader.getPersistedContext(),
    }, chatId, capabilities);

    const userMessage: StreamingUserMessage = {
      type: 'user',
      message: { role: 'user', content: enhancedContent },
      parent_tool_use_id: null,
      session_id: '',
    };

    // Push message to channel
    const channel = this.loopManager.getChannel();
    if (channel) {
      const accepted = channel.push(userMessage);
      if (!accepted) {
        this.logger.warn({ chatId, messageId }, 'Message rejected: channel is closed');
        this.callbacks.sendMessage(chatId, '⚠️ 消息未能送达，会话可能已结束。请发送 /reset 重置会话后重试。').catch(() => {});
        return;
      }
    } else {
      this.logger.error({ chatId, messageId }, 'No channel found after session creation');
      this.callbacks.sendMessage(chatId, '❌ 会话通道异常，请发送 /reset 重置会话后重试。').catch(() => {});
    }
  }

  /** Reset the agent session. Clears conversation history and state. */
  reset(chatId?: string, keepContext?: boolean): void {
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn({ boundChatId: this.boundChatId, requestedChatId: chatId }, 'Reset called for different chatId, ignoring');
      return;
    }

    this.logger.info({ chatId: this.boundChatId, keepContext }, 'Resetting ChatAgent session');
    this.loopManager.closeSession();
    this.conversationOrchestrator.deleteThreadRoot(this.boundChatId);
    this.restartManager.reset(this.boundChatId);
    this.historyLoader.clearAll();

    // Issue #1213: Reload history only if explicitly requested
    if (keepContext) {
      this.logger.info({ chatId: this.boundChatId }, 'Reloading history context after reset');
      this.historyLoader.loadPersistedHistory(this.callbacks, Config.getSessionRestoreConfig()).catch((err) => {
        this.logger.error({ err, chatId: this.boundChatId }, 'Failed to reload history after reset');
        this.callbacks.sendMessage(this.boundChatId, '⚠️ 重置后加载历史记录失败，当前会话无历史上下文。').catch(() => {});
      });
    }
  }

  getActiveSessionCount(): number { return this.loopManager.getActiveSessionCount(); }
  hasActiveSession(): boolean { return this.loopManager.isActive(); }

  /** Stop the current query without resetting the session (Issue #1349: /stop command). */
  stop(chatId?: string): boolean {
    if (chatId && chatId !== this.boundChatId) {
      this.logger.warn({ boundChatId: this.boundChatId, requestedChatId: chatId }, 'Stop called for different chatId, ignoring');
      return false;
    }
    if (!this.loopManager.getQueryHandle()) {
      this.logger.debug({ chatId: this.boundChatId }, 'No active query to stop');
      return false;
    }
    this.logger.info({ chatId: this.boundChatId }, 'Stopping current query');
    return this.loopManager.cancelQuery();
  }

  /** Implements Disposable interface (Issue #328). */
  dispose(): void {
    this.shutdown().catch((err) => { this.logger.error({ err }, 'Error during dispose shutdown'); });
    super.dispose();
  }

  async shutdown(): Promise<void> {
    await Promise.resolve();
    this.logger.info({ chatId: this.boundChatId }, 'Shutting down ChatAgent');
    this.loopManager.shutdown();
    this.conversationOrchestrator.clearAll();
    this.restartManager.clearAll();
    this.logger.info({ chatId: this.boundChatId }, 'ChatAgent shutdown complete');
  }
}

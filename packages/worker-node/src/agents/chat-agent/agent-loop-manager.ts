/**
 * AgentLoopManager - Manages the SDK agent loop lifecycle.
 *
 * Extracted from ChatAgent (Issue #2345 Phase 3) to reduce file size.
 *
 * Owns: channel, queryHandle, isSessionActive.
 * Handles: MCP server configuration, iterator processing, restart/circuit-breaker logic.
 */

import { Config, MessageChannel, RestartManager, ConversationOrchestrator, type StreamingUserMessage, type QueryHandle, type AgentQueryOptions, type QueryStreamResult, type CwdProvider } from '@disclaude/core';
import { createChannelMcpServer } from '@disclaude/mcp-server';
import type { ChatAgentCallbacks } from './types.js';
import type { ChatHistoryLoader } from './chat-history-loader.js';
import type { Logger } from 'pino';

/** Parameters needed to start an agent loop. */
export interface LoopContext {
  chatId: string;
  callbacks: ChatAgentCallbacks;
  historyLoader: ChatHistoryLoader;
  conversationOrchestrator: ConversationOrchestrator;
  restartManager: RestartManager;
  logger: Logger;
  createSdkOptions: (extra?: { disallowedTools?: string[]; mcpServers?: Record<string, unknown>; cwd?: string }) => AgentQueryOptions;
  createQueryStream: (input: AsyncGenerator<StreamingUserMessage>, options: AgentQueryOptions) => QueryStreamResult;
  /** Optional CwdProvider for per-chatId project context switching (Issue #1916) */
  cwdProvider?: CwdProvider;
}

export class AgentLoopManager {
  private channel?: MessageChannel;
  private queryHandle?: QueryHandle;
  private isSessionActive = false;
  private readonly ctx: LoopContext;

  constructor(context: LoopContext) {
    this.ctx = context;
  }

  isActive(): boolean { return this.isSessionActive; }
  getActiveSessionCount(): number { return this.isSessionActive ? 1 : 0; }
  getChannel(): MessageChannel | undefined { return this.channel; }
  getQueryHandle(): QueryHandle | undefined { return this.queryHandle; }
  clearQueryHandle(): void { this.queryHandle = undefined; }
  markInactive(): void { this.isSessionActive = false; }

  /** Start the Agent loop: creates channel, query, and begins iterator processing. */
  startLoop(): void {
    const { chatId, callbacks, historyLoader, logger, createSdkOptions, createQueryStream } = this.ctx;

    // Trigger background history loading (Issue #955, #1230)
    if (!historyLoader.isHistoryLoaded()) {
      historyLoader.loadPersistedHistory(callbacks, Config.getSessionRestoreConfig())
        .catch((err) => { logger.error({ err, chatId }, 'Failed to load persisted history in background'); });
    }
    if (!historyLoader.isFirstMessageHistoryLoaded() && callbacks.getChatHistory) {
      historyLoader.loadFirstMessageHistory(callbacks)
        .catch((err) => { logger.error({ err, chatId }, 'Failed to load first message history in background'); });
    }

    const mcpServers = this.buildMcpServers(chatId, callbacks);
    // Issue #1916: Resolve project cwd via CwdProvider (if configured)
    const projectCwd = this.ctx.cwdProvider?.(chatId);
    const sdkOptions = createSdkOptions({
      disallowedTools: ['EnterPlanMode'],
      mcpServers,
      ...(projectCwd && { cwd: projectCwd }),
    });

    logger.info(
      { chatId, mcpServers: Object.keys(sdkOptions.mcpServers || {}), supportedMcpTools: callbacks.getCapabilities?.(chatId)?.supportedMcpTools, projectCwd },
      'Starting SDK query with message channel',
    );

    this.channel = new MessageChannel();
    const { handle, iterator } = createQueryStream(this.channel.generator(), sdkOptions);
    this.queryHandle = handle;
    this.isSessionActive = true;

    this.processIterator(iterator).catch(async (err) => {
      logger.error({ err, chatId, errorMessage: err instanceof Error ? err.message : String(err) }, 'Agent loop error');
      this.isSessionActive = false;
      try {
        await callbacks.sendMessage(chatId, '❌ 处理消息时发生严重错误，会话已中断。请发送 /reset 重置会话后重试。');
      } catch (notifyErr) {
        logger.error({ err: notifyErr, chatId }, 'Failed to send agent loop error notification');
      }
    });
  }

  /** Push a message to the channel. Returns true if accepted. */
  tryPushMessage(message: StreamingUserMessage, chatId: string, messageId: string): boolean {
    if (!this.channel) {
      this.ctx.logger.error({ chatId, messageId }, 'tryPushMessage: no channel available');
      return false;
    }
    const accepted = this.channel.push(message);
    if (!accepted) {
      this.ctx.logger.warn({ chatId, messageId }, 'tryPushMessage: push rejected, channel is closed');
    }
    return accepted;
  }

  /** Cancel current query. Returns true if a query was cancelled. */
  cancelQuery(): boolean {
    if (!this.queryHandle) {
      return false;
    }
    this.queryHandle.cancel();
    this.queryHandle = undefined;
    return true;
  }

  /** Close session and release resources (for reset). */
  closeSession(): void {
    this.isSessionActive = false;
    this.channel?.close();
    this.channel = undefined;
    this.queryHandle?.close();
    this.queryHandle = undefined;
  }

  /** Full shutdown — close all resources. */
  shutdown(): void {
    this.isSessionActive = false;
    this.channel?.close();
    this.channel = undefined;
    this.queryHandle?.close();
    this.queryHandle = undefined;
  }

  // --- Private ---

  private buildMcpServers(chatId: string, callbacks: ChatAgentCallbacks): Record<string, unknown> {
    const capabilities = callbacks.getCapabilities?.(chatId);
    const supportedMcpTools = capabilities?.supportedMcpTools;
    const contextTools = ['send_text', 'send_card', 'send_interactive', 'send_file'];
    const shouldIncludeContextMcp = !supportedMcpTools || contextTools.some(t => supportedMcpTools.includes(t));

    const mcpServers: Record<string, unknown> = {};
    if (shouldIncludeContextMcp) {
      mcpServers['channel-mcp'] = createChannelMcpServer();
      this.ctx.logger.info({ ipcSocket: process.env.DISCLAUDE_WORKER_IPC_SOCKET }, 'Configured channel MCP server (inline transport)');
    }

    const configured = Config.getMcpServersConfig();
    if (configured) {
      for (const [name, cfg] of Object.entries(configured)) {
        mcpServers[name] = { type: 'stdio', command: cfg.command, args: cfg.args || [], ...(cfg.env && { env: cfg.env }) };
      }
    }
    return mcpServers;
  }

  /**
   * Process the SDK iterator. Preserves conversation context on unexpected end;
   * uses RestartManager for restart/circuit-breaker logic.
   */
  private async processIterator(
    iterator: AsyncGenerator<{ parsed: { type: string; content?: string } }>,
  ): Promise<void> {
    const { chatId, callbacks, conversationOrchestrator, restartManager, logger } = this.ctx;
    let iteratorError: Error | null = null;
    let messageCount = 0;

    try {
      for await (const { parsed } of iterator) {
        messageCount++;
        logger.debug({ chatId, messageCount, type: parsed.type }, 'SDK message received');

        if (parsed.content) {
          await callbacks.sendMessage(chatId, parsed.content, conversationOrchestrator.getThreadRoot(chatId));
        }
        if (parsed.type === 'result') {
          logger.info({ chatId, content: parsed.content }, 'Result received, turn complete');
          restartManager.recordSuccess(chatId);
          if (callbacks.onDone) {
            await callbacks.onDone(chatId, conversationOrchestrator.getThreadRoot(chatId));
          }
        }
      }
    } catch (error) {
      iteratorError = error as Error;
      logger.error({ err: iteratorError, chatId, messageCount }, 'Iterator error');
      const threadRoot = conversationOrchestrator.getThreadRoot(chatId);
      await callbacks.sendMessage(chatId, `❌ Session error: ${iteratorError.message}`, threadRoot);
      if (callbacks.onDone) {
        await callbacks.onDone(chatId, threadRoot);
      }
    }

    if (!this.isSessionActive) {
      logger.info({ chatId }, 'Agent loop completed (explicit close)');
      return;
    }

    this.isSessionActive = false;
    const errorMessage = iteratorError?.message ?? 'Unknown error';
    const decision = restartManager.shouldRestart(chatId, errorMessage);

    if (!decision.allowed) {
      logger.error({ chatId, reason: decision.reason, restartCount: decision.restartCount }, 'Restart blocked by circuit breaker');
      const threadRoot = conversationOrchestrator.getThreadRoot(chatId);
      const msg = decision.reason === 'max_restarts_exceeded'
        ? `🚫 会话多次异常中断，已暂停处理。请发送 /reset 重置会话。\n\n最近错误: ${errorMessage}`
        : `🚫 会话已暂停，请发送 /reset 重置。\n\n原因: ${decision.reason}`;
      await callbacks.sendMessage(chatId, msg, threadRoot);
      return;
    }

    logger.warn({ chatId, error: errorMessage, restartCount: decision.restartCount, waitMs: decision.waitMs }, 'Agent loop ended unexpectedly, attempting restart');
    if (decision.waitMs && decision.waitMs > 0) {
      await new Promise(r => setTimeout(r, decision.waitMs));
    }

    const threadRoot = conversationOrchestrator.getThreadRoot(chatId);
    const restartMsg = iteratorError
      ? `⚠️ 会话遇到错误，正在重新连接... (${iteratorError.message})`
      : '⚠️ 会话意外断开，正在重新连接...';
    await callbacks.sendMessage(chatId, restartMsg, threadRoot);
    this.startLoop();
    logger.info({ chatId }, 'Agent loop restarted');
  }
}

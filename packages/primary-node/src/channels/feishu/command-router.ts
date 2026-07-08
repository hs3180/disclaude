/**
 * Slash-command router for the Feishu channel (Issue #4126 part 2).
 *
 * Extracted from MessageHandler.handleMessageReceive(). Detects `/`-prefixed
 * commands, dispatches them via the control handler (when available) with
 * reset/status/stop fallbacks, and tells the caller whether the message was
 * consumed (so it can short-circuit) or should fall through to normal processing.
 *
 * @module primary-node/channels/feishu/command-router
 */

import {
  createControlCommand,
  type ControlCommand,
  type ControlCommandType,
  type ControlResponse,
} from '@disclaude/core';

/** A message to send back to the chat. */
export interface CommandReply {
  chatId: string;
  type: string;
  text: string;
}

/** Dependencies injected from MessageHandler. */
export interface CommandRouterDeps {
  /** Whether a control handler is wired up (enables /trigger etc. via emitControl). */
  hasControlHandler: boolean;
  /** Emit a control command and get its response. */
  emitControl(command: ControlCommand): Promise<ControlResponse>;
  /** Send a text reply to the chat. */
  sendMessage(reply: CommandReply): Promise<void>;
}

/** Inputs needed to evaluate a command. */
export interface CommandRouterInput {
  /** Message text with leading @mentions stripped. */
  textWithoutMentions: string;
  chatId: string;
}

/**
 * Try to handle a `/`-prefixed command.
 *
 * @returns `true` if the message was a recognized command and was consumed
 *   (caller should stop processing); `false` if it should fall through.
 *
 * Behavior:
 * - Non-`/` text → `false` (not a command).
 * - With a control handler: emit the command; if the handler reports success or
 *   a message, relay the message and return `true`; otherwise fall through to
 *   the reset/status/stop fallbacks.
 * - reset / status / stop fallbacks (used when no control handler, or the handler
 *   didn't recognize the command) send a canned reply and return `true`.
 * - Unrecognized `/`-command → `false` (processed as normal text upstream).
 */
export async function tryHandleSlashCommand(
  input: CommandRouterInput,
  deps: CommandRouterDeps,
): Promise<boolean> {
  if (!input.textWithoutMentions.startsWith('/')) {
    return false;
  }

  const [command, ...args] = input.textWithoutMentions.slice(1).split(/\s+/);
  const cmd = command.toLowerCase();

  // Control-handler path (Issue #3529: typed command data).
  if (deps.hasControlHandler) {
    const rawData = { args };
    const response = await deps.emitControl(
      createControlCommand(cmd as ControlCommandType, input.chatId, rawData),
    );

    // Issue #1562: relay both success and error messages from the control handler.
    if (response.success || response.message) {
      if (response.message) {
        await deps.sendMessage({ chatId: input.chatId, type: 'text', text: response.message });
      }
      return true;
    }
  }

  // Fallback command handling (when controlHandler is unavailable or didn't match).
  if (cmd === 'reset') {
    await deps.sendMessage({
      chatId: input.chatId,
      type: 'text',
      text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
    });
    return true;
  }

  if (cmd === 'status') {
    await deps.sendMessage({
      chatId: input.chatId,
      type: 'text',
      text: '📊 **状态**\n\nChannel: Feishu\nStatus: running',
    });
    return true;
  }

  // Issue #1494: fallback /stop handling.
  if (cmd === 'stop') {
    await deps.sendMessage({
      chatId: input.chatId,
      type: 'text',
      text: '⏹️ **停止命令已发送**\n\n当前会话将尝试停止响应。',
    });
    return true;
  }

  return false;
}

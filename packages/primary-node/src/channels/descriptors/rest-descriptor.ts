/**
 * REST Channel Descriptor
 *
 * Declarative wiring for REST channel: factory, callbacks, and message handler.
 * The default message handler from ChannelLifecycleManager is used.
 *
 * Part of Issue #1594: Unify fragmented channel management architecture.
 *
 * @module @disclaude/primary-node/channels/descriptors/rest
 */

import { createLogger, type IChannel } from '@disclaude/core';
import type { PilotCallbacks } from '@disclaude/worker-node';
import { RestChannel, type RestChannelConfig } from '../rest-channel.js';
import type { ChannelDescriptor, ChannelSetupContext, PilotCallbacksFactory } from '../../channel-descriptor.js';

const logger = createLogger('RestDescriptor');

/**
 * Create PilotCallbacks factory for REST channel.
 *
 * REST channel uses synchronous mode: sends 'done' signal after completion
 * so the REST client knows the response is complete.
 */
function createRestCallbacksFactory(channel: IChannel): PilotCallbacksFactory {
  return (_chatId: string): PilotCallbacks => ({
    sendMessage: async (chatId: string, text: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'text',
        text,
        threadId: parentMessageId,
      });
    },
    sendCard: async (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => {
      await channel.sendMessage({
        chatId,
        type: 'card',
        card,
        description,
        threadId: parentMessageId,
      });
    },
    // eslint-disable-next-line require-await
    sendFile: async (chatId: string, filePath: string) => {
      logger.warn({ chatId, filePath }, 'File sending not implemented for REST channel');
    },
    onDone: async (chatId: string, parentMessageId?: string) => {
      logger.info({ chatId }, 'Task completed');
      // Signal completion for sync mode
      await channel.sendMessage({
        chatId,
        type: 'done',
        threadId: parentMessageId,
      });
    },
  });
}

/**
 * REST channel descriptor.
 *
 * Uses the default message handler from ChannelLifecycleManager.
 * Sets `sendDoneSignal: true` for synchronous REST mode.
 */
export const restDescriptor: ChannelDescriptor<RestChannelConfig> = {
  type: 'rest',
  name: 'REST Channel',
  factory: (config: RestChannelConfig) => new RestChannel(config),
  sendDoneSignal: true,
  createCallbacks: (channel: IChannel, _context: ChannelSetupContext) =>
    createRestCallbacksFactory(channel),
};

/**
 * InternalEventBus — lightweight typed pub/sub for decoupled event propagation.
 *
 * Issue #4031: Enables topic group message notification and future consumers
 * (audit logging, message stats, etc.) to subscribe without coupling to
 * FeishuChannel internals.
 *
 * Design:
 * - Wraps Node.js EventEmitter for consistency with BaseChannel, WsConnectionManager, PrimaryNode
 * - Typed on/off/emit API via InternalEventMap
 * - Async handler execution with error isolation (one handler failure doesn't affect others)
 * - Simple on/off/emit API, no wildcards or namespaces
 */

import { EventEmitter } from 'events';
import type { TopicGroupMessageEvent } from './types/websocket-messages.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('InternalEventBus');

/** All known internal event types. Extend this map to add new events. */
export interface InternalEventMap {
  'feishu.topic.message': TopicGroupMessageEvent;
}

type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Lightweight typed event bus wrapping Node.js EventEmitter.
 *
 * Usage:
 * ```ts
 * const bus = new InternalEventBus();
 * bus.on('feishu.topic.message', (evt) => console.log(evt.chatId));
 * bus.emit('feishu.topic.message', { type: 'topic_group_message', ... });
 * ```
 */
export class InternalEventBus {
  private emitter = new EventEmitter();
  private handlerMap = new Map<string, Map<EventHandler<unknown>, EventHandler<unknown>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<E extends keyof InternalEventMap>(
    event: E,
    handler: EventHandler<InternalEventMap[E]>,
  ): () => void {
    const key = event as string;

    // Wrap handler for async execution with error isolation
    const wrapped = ((payload: InternalEventMap[E]) => {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          logger.warn(
            { err, event: key },
            `Handler error on "${key}"`,
          );
        });
    }) as EventHandler<unknown>;

    // Track wrapped handler for off()/listenerCount()
    let inner = this.handlerMap.get(key);
    if (!inner) {
      inner = new Map();
      this.handlerMap.set(key, inner);
    }
    inner.set(handler as EventHandler<unknown>, wrapped);

    this.emitter.on(key, wrapped);

    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe a specific handler from an event.
   */
  off<E extends keyof InternalEventMap>(
    event: E,
    handler: EventHandler<InternalEventMap[E]>,
  ): void {
    const key = event as string;
    const inner = this.handlerMap.get(key);
    if (!inner) { return; }

    const wrapped = inner.get(handler as EventHandler<unknown>);
    if (wrapped) {
      this.emitter.off(key, wrapped);
      inner.delete(handler as EventHandler<unknown>);
      if (inner.size === 0) {
        this.handlerMap.delete(key);
      }
    }
  }

  /**
   * Emit an event to all registered handlers.
   * Handlers run asynchronously; errors are caught and logged per handler.
   */
  emit<E extends keyof InternalEventMap>(event: E, payload: InternalEventMap[E]): void {
    this.emitter.emit(event as string, payload);
  }

  /**
   * Remove all handlers for a specific event, or all events if no event specified.
   */
  removeAllListeners(event?: keyof InternalEventMap): void {
    if (event) {
      this.emitter.removeAllListeners(event as string);
      this.handlerMap.delete(event as string);
    } else {
      this.emitter.removeAllListeners();
      this.handlerMap.clear();
    }
  }

  /**
   * Get the number of handlers for a given event (useful for testing).
   */
  listenerCount(event: keyof InternalEventMap): number {
    return this.handlerMap.get(event as string)?.size ?? 0;
  }
}

/**
 * Default singleton instance for application-wide use.
 *
 * Relies on ESM module singleton guarantee — this module is only evaluated once
 * per process regardless of how many importers reference it.
 */
export const eventBus = new InternalEventBus();

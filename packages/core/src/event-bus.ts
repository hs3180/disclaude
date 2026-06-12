/**
 * InternalEventBus — lightweight typed pub/sub for decoupled event propagation.
 *
 * Issue #4031: Enables topic group message notification and future consumers
 * (audit logging, message stats, etc.) to subscribe without coupling to
 * FeishuChannel internals.
 *
 * Design:
 * - Synchronous emit, async handler execution
 * - Error isolation: one handler failure does not affect others
 * - Simple on/off/emit API, no wildcards or namespaces
 */

import type { TopicGroupMessageEvent } from './types/websocket-messages.js';

/** All known internal event types. Extend this union to add new events. */
export type InternalEventMap = {
  'feishu.message.receive': { raw: unknown };
  'feishu.topic.message': TopicGroupMessageEvent;
  'feishu.card.action': { raw: unknown };
};

type EventHandler<T> = (payload: T) => void | Promise<void>;

/**
 * Lightweight typed event bus.
 *
 * Usage:
 * ```ts
 * const bus = new InternalEventBus();
 * bus.on('feishu.topic.message', (evt) => console.log(evt.chatId));
 * bus.emit('feishu.topic.message', { type: 'topic_group_message', ... });
 * ```
 */
export class InternalEventBus {
  private handlers = new Map<string, Set<EventHandler<unknown>>>();

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on<E extends keyof InternalEventMap>(
    event: E,
    handler: EventHandler<InternalEventMap[E]>,
  ): () => void {
    let set = this.handlers.get(event as string);
    if (!set) {
      set = new Set();
      this.handlers.set(event as string, set);
    }
    set.add(handler as EventHandler<unknown>);

    // Return unsubscribe function
    return () => {
      set.delete(handler as EventHandler<unknown>);
      if (set.size === 0) {
        this.handlers.delete(event as string);
      }
    };
  }

  /**
   * Unsubscribe a specific handler from an event.
   */
  off<E extends keyof InternalEventMap>(
    event: E,
    handler: EventHandler<InternalEventMap[E]>,
  ): void {
    const set = this.handlers.get(event as string);
    if (set) {
      set.delete(handler as EventHandler<unknown>);
      if (set.size === 0) {
        this.handlers.delete(event as string);
      }
    }
  }

  /**
   * Emit an event to all registered handlers.
   * Handlers run asynchronously; errors are caught and logged per handler.
   */
  emit<E extends keyof InternalEventMap>(event: E, payload: InternalEventMap[E]): void {
    const set = this.handlers.get(event as string);
    if (!set) {return;}

    for (const handler of set) {
      // Async execution with error isolation
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          // Use console.warn since we may not have access to logger here
          console.warn(
            `[InternalEventBus] Handler error on "${event as string}":`,
            err instanceof Error ? err.message : err,
          );
        });
    }
  }

  /**
   * Remove all handlers for a specific event, or all events if no event specified.
   */
  removeAllListeners(event?: keyof InternalEventMap): void {
    if (event) {
      this.handlers.delete(event as string);
    } else {
      this.handlers.clear();
    }
  }

  /**
   * Get the number of handlers for a given event (useful for testing).
   */
  listenerCount(event: keyof InternalEventMap): number {
    return this.handlers.get(event as string)?.size ?? 0;
  }
}

/** Default singleton instance for application-wide use. */
export const eventBus = new InternalEventBus();

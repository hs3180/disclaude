/**
 * InternalEventBus — lightweight typed pub/sub for decoupled event propagation.
 *
 * Issue #4031: Enables topic group message notification and future consumers
 * (audit logging, message stats, etc.) to subscribe without coupling to
 * FeishuChannel internals.
 *
 * Design:
 * - Wraps Node.js EventEmitter for consistency with BaseChannel, WsConnectionManager, DisclaudeService
 * - Typed on/off/emit API via InternalEventMap
 * - Async handler execution with error isolation (one handler failure doesn't affect others)
 * - Simple on/off/emit API, no wildcards or namespaces
 */
import { EventEmitter } from 'events';
import { createLogger } from './utils/logger.js';
const logger = createLogger('InternalEventBus');
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
    emitter = new EventEmitter();
    handlerMap = new Map();
    /**
     * Subscribe to an event. Returns an unsubscribe function.
     */
    on(event, handler) {
        const key = event;
        // Wrap handler for async execution with error isolation
        const wrapped = ((payload) => {
            Promise.resolve()
                .then(() => handler(payload))
                .catch((err) => {
                logger.warn({ err, event: key }, `Handler error on "${key}"`);
            });
        });
        // Track wrapped handler for off()/listenerCount()
        let inner = this.handlerMap.get(key);
        if (!inner) {
            inner = new Map();
            this.handlerMap.set(key, inner);
        }
        inner.set(handler, wrapped);
        this.emitter.on(key, wrapped);
        return () => this.off(event, handler);
    }
    /**
     * Unsubscribe a specific handler from an event.
     */
    off(event, handler) {
        const key = event;
        const inner = this.handlerMap.get(key);
        if (!inner) {
            return;
        }
        const wrapped = inner.get(handler);
        if (wrapped) {
            this.emitter.off(key, wrapped);
            inner.delete(handler);
            if (inner.size === 0) {
                this.handlerMap.delete(key);
            }
        }
    }
    /**
     * Emit an event to all registered handlers.
     * Handlers run asynchronously; errors are caught and logged per handler.
     */
    emit(event, payload) {
        this.emitter.emit(event, payload);
    }
    /**
     * Remove all handlers for a specific event, or all events if no event specified.
     */
    removeAllListeners(event) {
        if (event) {
            this.emitter.removeAllListeners(event);
            this.handlerMap.delete(event);
        }
        else {
            this.emitter.removeAllListeners();
            this.handlerMap.clear();
        }
    }
    /**
     * Get the number of handlers for a given event (useful for testing).
     */
    listenerCount(event) {
        return this.handlerMap.get(event)?.size ?? 0;
    }
}
/**
 * Default singleton instance for application-wide use.
 *
 * Relies on ESM module singleton guarantee — this module is only evaluated once
 * per process regardless of how many importers reference it.
 */
export const eventBus = new InternalEventBus();

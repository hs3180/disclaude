/**
 * TriggerBus - Lightweight event bus for schedule triggering.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Provides a pub/sub mechanism that allows any module to signal
 * a schedule to execute immediately, without waiting for cron.
 *
 * Design principles:
 * - Zero dependencies (uses Node.js EventEmitter)
 * - Singleton pattern via exported instance
 * - Decoupled from Scheduler (Scheduler subscribes, Skills publish)
 * - Cron remains as fallback (event triggers are additive)
 *
 * Usage:
 * ```typescript
 * // In a Skill (publisher):
 * import { triggerBus } from './trigger-bus.js';
 * triggerBus.emit('chat:pending', { chatId: 'oc_xxx' });
 *
 * // In Scheduler (subscriber):
 * triggerBus.on('chat:pending', (data) => {
 *   scheduler.trigger('schedule-chats-activation');
 * });
 * ```
 *
 * @module @disclaude/core/scheduling
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('TriggerBus');

/**
 * Event data payload for trigger events.
 */
export interface TriggerEventData {
  /** Name of the event */
  event: string;
  /** Timestamp when the event was emitted */
  timestamp: number;
  /** Optional data payload */
  data?: unknown;
}

/**
 * Handler function type for trigger events.
 */
export type TriggerHandler = (data: TriggerEventData) => void;

/**
 * TriggerBus - Event bus for triggering schedules on demand.
 *
 * Provides a decoupled communication channel between event producers
 * (Skills, file watchers, etc.) and event consumers (Scheduler).
 *
 * Key features:
 * - Named events with optional data payloads
 * - Debounce support to prevent rapid-fire triggers
 * - Event history for debugging
 * - Subscription management (on/off/once)
 */
export class TriggerBus {
  private emitter: EventEmitter;
  /** Map of debounce timers keyed by "event:handlerId" */
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  /** Maximum event history entries */
  private readonly maxHistory: number;
  /** Recent event history for debugging */
  private history: TriggerEventData[] = [];

  constructor(options?: { maxHistory?: number }) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50); // Allow many subscribers
    this.maxHistory = options?.maxHistory ?? 100;
  }

  /**
   * Emit a trigger event.
   * Any schedules listening for this event will be triggered.
   *
   * @param event - Event name (e.g., 'chat:pending', 'file:created')
   * @param data - Optional data payload
   */
  emit(event: string, data?: unknown): void {
    const eventData: TriggerEventData = {
      event,
      timestamp: Date.now(),
      data,
    };

    // Record in history
    this.history.push(eventData);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    logger.debug({ event, hasData: data !== undefined }, 'Trigger event emitted');
    this.emitter.emit('trigger', eventData);
    this.emitter.emit(`trigger:${event}`, eventData);
  }

  /**
   * Subscribe to all trigger events.
   *
   * @param handler - Handler function called on any trigger event
   * @returns This instance for chaining
   */
  onAny(handler: TriggerHandler): this {
    this.emitter.on('trigger', handler);
    return this;
  }

  /**
   * Subscribe to a specific trigger event.
   *
   * @param event - Event name to listen for
   * @param handler - Handler function called when event fires
   * @returns This instance for chaining
   */
  on(event: string, handler: TriggerHandler): this {
    this.emitter.on(`trigger:${event}`, handler);
    return this;
  }

  /**
   * Subscribe to a trigger event with debouncing.
   * If the same event fires multiple times within the debounce window,
   * only the first one is processed.
   *
   * @param event - Event name to listen for
   * @param handler - Handler function called when event fires
   * @param debounceMs - Debounce interval in milliseconds
   * @param handlerId - Unique ID for debounce tracking (defaults to event name)
   * @returns This instance for chaining
   */
  onDebounced(
    event: string,
    handler: TriggerHandler,
    debounceMs: number,
    handlerId?: string,
  ): this {
    const id = handlerId ?? event;

    const wrappedHandler = (eventData: TriggerEventData): void => {
      // Clear existing timer
      const existingTimer = this.debounceTimers.get(id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer
      const timer = setTimeout(() => {
        this.debounceTimers.delete(id);
        handler(eventData);
      }, debounceMs);

      this.debounceTimers.set(id, timer);
    };

    // Store reference for cleanup
    this.emitter.on(`trigger:${event}`, wrappedHandler);
    return this;
  }

  /**
   * Subscribe to a trigger event once.
   * Automatically unsubscribes after the first invocation.
   *
   * @param event - Event name to listen for
   * @param handler - Handler function called once
   * @returns This instance for chaining
   */
  once(event: string, handler: TriggerHandler): this {
    this.emitter.once(`trigger:${event}`, handler);
    return this;
  }

  /**
   * Unsubscribe from a specific trigger event.
   *
   * @param event - Event name to stop listening for
   * @param handler - The handler to remove
   * @returns This instance for chaining
   */
  off(event: string, handler: TriggerHandler): this {
    this.emitter.off(`trigger:${event}`, handler);
    return this;
  }

  /**
   * Unsubscribe from all trigger events.
   *
   * @returns This instance for chaining
   */
  offAll(): this {
    this.emitter.removeAllListeners();
    this.clearDebounce();
    return this;
  }

  /**
   * Clear all pending debounce timers.
   */
  clearDebounce(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Get recent event history for debugging.
   *
   * @param limit - Maximum number of events to return (default: 20)
   * @returns Array of recent trigger events
   */
  getHistory(limit = 20): TriggerEventData[] {
    return this.history.slice(-limit);
  }

  /**
   * Get the number of listeners for a specific event.
   *
   * @param event - Event name
   * @returns Number of listeners
   */
  listenerCount(event: string): number {
    return this.emitter.listenerCount(`trigger:${event}`);
  }
}

/**
 * Singleton TriggerBus instance.
 * Shared across the application for decoupled communication.
 *
 * Issue #1953: This is the core infrastructure that enables
 * event-driven schedule triggering.
 */
export const triggerBus = new TriggerBus();

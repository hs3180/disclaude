/**
 * Tests for TriggerBus.
 *
 * Issue #1953: Event-driven schedule trigger mechanism.
 *
 * Verifies event emission, subscription management, debouncing,
 * and event history.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TriggerBus } from './trigger-bus.js';

describe('TriggerBus', () => {
  let bus: TriggerBus;

  beforeEach(() => {
    bus = new TriggerBus({ maxHistory: 10 });
  });

  afterEach(() => {
    bus.offAll();
  });

  describe('constructor', () => {
    it('should create a TriggerBus instance', () => {
      expect(bus).toBeInstanceOf(TriggerBus);
    });

    it('should accept maxHistory option', () => {
      const customBus = new TriggerBus({ maxHistory: 5 });
      expect(customBus).toBeInstanceOf(TriggerBus);
      customBus.offAll();
    });
  });

  describe('emit / on', () => {
    it('should deliver events to subscribers', () => {
      const handler = vi.fn();
      bus.on('test-event', handler);

      bus.emit('test-event');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should deliver event data to subscribers', () => {
      const handler = vi.fn();
      bus.on('test-event', handler);

      const payload = { chatId: 'oc_xxx' };
      bus.emit('test-event', payload);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'test-event',
          data: payload,
        }),
      );
    });

    it('should not deliver events to wrong subscribers', () => {
      const handler = vi.fn();
      bus.on('test-event', handler);

      bus.emit('other-event');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple subscribers for the same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('test-event', handler1);
      bus.on('test-event', handler2);

      bus.emit('test-event');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should support subscribing to multiple events', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('event-a', handler1);
      bus.on('event-b', handler2);

      bus.emit('event-a');
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();

      bus.emit('event-b');
      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAny', () => {
    it('should receive all events', () => {
      const handler = vi.fn();
      bus.onAny(handler);

      bus.emit('event-a');
      bus.emit('event-b');

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'event-a' }),
      );
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'event-b' }),
      );
    });
  });

  describe('once', () => {
    it('should receive event only once', () => {
      const handler = vi.fn();
      bus.once('test-event', handler);

      bus.emit('test-event');
      bus.emit('test-event');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('off', () => {
    it('should unsubscribe from an event', () => {
      const handler = vi.fn();
      bus.on('test-event', handler);

      bus.emit('test-event');
      expect(handler).toHaveBeenCalledTimes(1);

      bus.off('test-event', handler);
      bus.emit('test-event');
      expect(handler).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('offAll', () => {
    it('should remove all subscriptions', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('event-a', handler1);
      bus.on('event-b', handler2);

      bus.offAll();

      bus.emit('event-a');
      bus.emit('event-b');

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe('onDebounced', () => {
    it('should debounce rapid events', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();

      bus.onDebounced('test-event', handler, 100);

      // Fire 3 rapid events
      bus.emit('test-event');
      bus.emit('test-event');
      bus.emit('test-event');

      // Handler should not be called yet
      expect(handler).not.toHaveBeenCalled();

      // Wait for debounce
      await vi.advanceTimersByTimeAsync(150);

      // Only one call (first event was processed)
      expect(handler).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should fire again after debounce period', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();

      bus.onDebounced('test-event', handler, 50);

      bus.emit('test-event');
      await vi.advanceTimersByTimeAsync(100);

      bus.emit('test-event');
      await vi.advanceTimersByTimeAsync(100);

      expect(handler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it('should support custom handlerId for separate debounce tracking', async () => {
      vi.useFakeTimers();
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.onDebounced('test-event', handler1, 50, 'handler-1');
      bus.onDebounced('test-event', handler2, 50, 'handler-2');

      bus.emit('test-event');
      await vi.advanceTimersByTimeAsync(100);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('clearDebounce', () => {
    it('should clear pending debounce timers', async () => {
      vi.useFakeTimers();
      const handler = vi.fn();

      bus.onDebounced('test-event', handler, 200);
      bus.emit('test-event');

      bus.clearDebounce();
      await vi.advanceTimersByTimeAsync(300);

      // Handler should not be called since debounce was cleared
      expect(handler).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  describe('getHistory', () => {
    it('should track event history', () => {
      bus.emit('event-a');
      bus.emit('event-b', { key: 'value' });

      const history = bus.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(
        expect.objectContaining({
          event: 'event-a',
          data: undefined,
        }),
      );
      expect(history[1]).toEqual(
        expect.objectContaining({
          event: 'event-b',
          data: { key: 'value' },
        }),
      );
    });

    it('should limit history to maxHistory', () => {
      for (let i = 0; i < 20; i++) {
        bus.emit(`event-${i}`);
      }

      const history = bus.getHistory();
      // maxHistory is 10, so only last 10 should be kept
      expect(history).toHaveLength(10);
      expect(history[0].event).toBe('event-10');
      expect(history[9].event).toBe('event-19');
    });

    it('should accept a limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        bus.emit(`event-${i}`);
      }

      const history = bus.getHistory(3);
      expect(history).toHaveLength(3);
    });
  });

  describe('listenerCount', () => {
    it('should return 0 for events with no listeners', () => {
      expect(bus.listenerCount('no-event')).toBe(0);
    });

    it('should return the number of listeners for an event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      bus.on('test-event', handler1);
      expect(bus.listenerCount('test-event')).toBe(1);

      bus.on('test-event', handler2);
      expect(bus.listenerCount('test-event')).toBe(2);

      bus.off('test-event', handler1);
      expect(bus.listenerCount('test-event')).toBe(1);
    });
  });

  describe('chaining', () => {
    it('should support method chaining', () => {
      const handler = vi.fn();
      const result = bus.on('event-a', handler).on('event-b', handler);

      expect(result).toBe(bus);
    });
  });

  describe('event timestamp', () => {
    it('should include timestamp in event data', () => {
      const handler = vi.fn();
      bus.on('test-event', handler);

      const before = Date.now();
      bus.emit('test-event');
      const after = Date.now();

      const [[call]] = handler.mock.calls;
      expect(call.timestamp).toBeGreaterThanOrEqual(before);
      expect(call.timestamp).toBeLessThanOrEqual(after);
    });
  });
});

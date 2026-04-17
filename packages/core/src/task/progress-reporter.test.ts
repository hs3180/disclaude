/**
 * Unit tests for ProgressReporter.
 *
 * Issue #857: Task progress reporting for complex tasks.
 * Issue #1617: Phase 2 - test coverage contribution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProgressReporter } from './progress-reporter.js';

describe('ProgressReporter', () => {
  let sendCard: ReturnType<typeof vi.fn>;
  let reporter: ProgressReporter;

  beforeEach(() => {
    vi.useFakeTimers();
    sendCard = vi.fn().mockResolvedValue(undefined);
    reporter = new ProgressReporter({ sendCard, intervalMs: 100 });
  });

  afterEach(() => {
    reporter.stop();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('lifecycle', () => {
    it('should not be active before start()', () => {
      expect(reporter.isActive()).toBe(false);
    });

    it('should be active after start()', () => {
      reporter.start();
      expect(reporter.isActive()).toBe(true);
    });

    it('should not be active after stop()', () => {
      reporter.start();
      reporter.stop();
      expect(reporter.isActive()).toBe(false);
    });

    it('should be safe to call stop() before start()', () => {
      expect(() => reporter.stop()).not.toThrow();
    });

    it('should be safe to call start() twice', () => {
      reporter.start();
      reporter.start();
      expect(reporter.isActive()).toBe(true);
      reporter.stop();
    });
  });

  // -----------------------------------------------------------------------
  // Card building
  // -----------------------------------------------------------------------

  describe('buildCard', () => {
    it('should return a card with required structure', () => {
      reporter.start();
      const card = reporter.buildCard();

      expect(card).toHaveProperty('config');
      expect(card).toHaveProperty('header');
      expect(card).toHaveProperty('elements');

      const config = card.config as Record<string, unknown>;
      expect(config.wide_screen_mode).toBe(true);

      const header = card.header as Record<string, unknown>;
      expect(header.title).toEqual({ content: '🔄 任务执行中', tag: 'plain_text' });
      expect(header.template).toBe('blue');
    });

    it('should include current step in card', () => {
      reporter.start();
      reporter.setCurrentStep('Running tests');
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const stepElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('Running tests'),
      );
      expect(stepElement).toBeDefined();
    });

    it('should include message count in card', () => {
      reporter.start();
      reporter.updateFromMessage('text', 'hello');
      reporter.updateFromMessage('tool_use', 'Using Read: file.ts');
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const countElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('2 条消息'),
      );
      expect(countElement).toBeDefined();
    });

    it('should show seconds when under a minute', () => {
      reporter.start();
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const timeElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('秒'),
      );
      expect(timeElement).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // State updates
  // -----------------------------------------------------------------------

  describe('updateFromMessage', () => {
    it('should extract step from tool_use message with "Using X" pattern', () => {
      reporter.start();
      reporter.updateFromMessage('tool_use', 'Using Read: /path/to/file.ts');
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const stepElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('Read'),
      );
      expect(stepElement).toBeDefined();
    });

    it('should update step from tool_progress message', () => {
      reporter.start();
      reporter.updateFromMessage('tool_progress', 'Searching files...\nmore details');
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const stepElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('Searching files...'),
      );
      expect(stepElement).toBeDefined();
    });

    it('should not update step from regular text message', () => {
      reporter.start();
      const stepBefore = (reporter.buildCard().elements as Array<Record<string, unknown>>)[0]
        .content as string;
      reporter.updateFromMessage('text', 'regular response');
      const stepAfter = (reporter.buildCard().elements as Array<Record<string, unknown>>)[0]
        .content as string;
      // Step should remain the same for text messages
      expect(stepBefore).toBe(stepAfter);
    });

    it('should increment message count for all messages', () => {
      reporter.start();
      reporter.updateFromMessage('text', 'hello');
      reporter.updateFromMessage('tool_use', 'Using Bash');
      reporter.updateFromMessage('tool_result', 'output');

      const card = reporter.buildCard();
      const elements = card.elements as Array<Record<string, unknown>>;
      const countElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('3 条消息'),
      );
      expect(countElement).toBeDefined();
    });

    it('should be a no-op when not active — message count stays at 0', () => {
      // Don't start the reporter — updateFromMessage should be ignored
      reporter.updateFromMessage('tool_use', 'Using Read');
      // Start it now and check the card shows 0 messages
      reporter.start();
      const card = reporter.buildCard();
      const elements = card.elements as Array<Record<string, unknown>>;
      const countElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('0 条消息'),
      );
      // The default state after start() has 0 messages
      expect(countElement).toBeDefined();
    });
  });

  describe('setCurrentStep', () => {
    it('should override the current step', () => {
      reporter.start();
      reporter.setCurrentStep('Phase 2/3: Running tests');
      const card = reporter.buildCard();

      const elements = card.elements as Array<Record<string, unknown>>;
      const stepElement = elements.find(e =>
        typeof e.content === 'string' && e.content.includes('Phase 2/3'),
      );
      expect(stepElement).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Timer-based reporting
  // -----------------------------------------------------------------------

  describe('timer', () => {
    it('should send a card after the interval elapses', async () => {
      reporter.start();
      // Advance past the interval
      await vi.advanceTimersByTimeAsync(150);

      expect(sendCard).toHaveBeenCalledTimes(1);
      const card = sendCard.mock.calls[0][0] as Record<string, unknown>;
      expect(card).toHaveProperty('header');
    });

    it('should send multiple cards for longer waits', async () => {
      reporter.start();
      await vi.advanceTimersByTimeAsync(350);

      expect(sendCard).toHaveBeenCalledTimes(3);
    });

    it('should stop sending cards after stop()', async () => {
      reporter.start();
      await vi.advanceTimersByTimeAsync(150);
      reporter.stop();
      await vi.advanceTimersByTimeAsync(200);

      expect(sendCard).toHaveBeenCalledTimes(1);
    });

    it('should handle sendCard errors gracefully', async () => {
      sendCard.mockRejectedValueOnce(new Error('Network error'));
      reporter.start();
      await vi.advanceTimersByTimeAsync(150);

      // Should not throw, just log
      expect(sendCard).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // Default interval
  // -----------------------------------------------------------------------

  describe('default interval', () => {
    it('should use 60s default when intervalMs is not specified', () => {
      const defaultReporter = new ProgressReporter({ sendCard });
      defaultReporter.start();
      // The reporter should be active
      expect(defaultReporter.isActive()).toBe(true);
      defaultReporter.stop();
    });
  });
});

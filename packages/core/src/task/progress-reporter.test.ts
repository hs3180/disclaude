/**
 * Unit tests for ProgressReporter (Issue #857)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ProgressReporter, type ProgressCard } from './progress-reporter.js';

describe('ProgressReporter', () => {
  let reporter: ProgressReporter;
  let sentCards: ProgressCard[];

  beforeEach(() => {
    vi.useFakeTimers();
    sentCards = [];
    reporter = new ProgressReporter({
      sendCard: (card) => { sentCards.push(card); },
      reportIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    reporter.stop();
    vi.useRealTimers();
  });

  describe('start', () => {
    it('should initialize progress tracking', () => {
      reporter.start('task-1', ['Step A', 'Step B', 'Step C']);

      const state = reporter.getState();
      expect(state.status).toBe('running');
      expect(state.taskId).toBe('task-1');
      expect(state.totalSteps).toBe(3);
      expect(state.completedSteps).toBe(0);
      expect(state.currentStep).toBeNull();
    });

    it('should clear previous tracking state', () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);
      reporter.start('task-2', ['Step X', 'Step Y']);

      const state = reporter.getState();
      expect(state.taskId).toBe('task-2');
      expect(state.totalSteps).toBe(2);
      expect(state.completedSteps).toBe(0);
    });

    it('should not send a card immediately on start', () => {
      reporter.start('task-1', ['Step A']);
      expect(sentCards).toHaveLength(0);
    });

    it('should send a card after the interval elapses', () => {
      reporter.start('task-1', ['Step A']);
      vi.advanceTimersByTime(60_000);
      expect(sentCards).toHaveLength(1);
    });

    it('should send multiple cards at each interval', () => {
      reporter.start('task-1', ['Step A', 'Step B']);
      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);
      expect(sentCards).toHaveLength(2);
    });

    it('should use default 60s interval when not specified', () => {
      const defaultReporter = new ProgressReporter({
        sendCard: (card) => { sentCards.push(card); },
      });
      defaultReporter.start('task-1', ['Step A']);

      // Should not fire at 59s
      vi.advanceTimersByTime(59_999);
      expect(sentCards).toHaveLength(0);

      // Should fire at 60s
      vi.advanceTimersByTime(1);
      expect(sentCards).toHaveLength(1);

      defaultReporter.stop();
    });

    it('should accept custom interval', () => {
      const customReporter = new ProgressReporter({
        sendCard: (card) => { sentCards.push(card); },
        reportIntervalMs: 10_000,
      });
      customReporter.start('task-1', ['Step A']);

      vi.advanceTimersByTime(10_000);
      expect(sentCards).toHaveLength(1);

      customReporter.stop();
    });
  });

  describe('updateStep', () => {
    it('should update current step', () => {
      reporter.start('task-1', ['Step A', 'Step B', 'Step C']);
      reporter.updateStep(1, 'Working on B');

      const state = reporter.getState();
      expect(state.currentStep).toBe('Step B');
    });

    it('should mark previous step as done', () => {
      reporter.start('task-1', ['Step A', 'Step B', 'Step C']);
      reporter.updateStep(0);
      reporter.updateStep(1);

      const state = reporter.getState();
      expect(state.completedSteps).toBe(1);
    });

    it('should accept step without detail', () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);

      const state = reporter.getState();
      expect(state.currentStep).toBe('Step A');
    });

    it('should not update when not running', () => {
      reporter.updateStep(0, 'detail');
      const state = reporter.getState();
      expect(state.currentStep).toBeNull();
    });
  });

  describe('setNextStepHint', () => {
    it('should include hint in progress card', async () => {
      reporter.start('task-1', ['Step A', 'Step B']);
      reporter.updateStep(0);
      reporter.setNextStepHint('will run tests');

      await reporter.reportNow();

      expect(sentCards).toHaveLength(1);
      const [card] = sentCards;
      const hintElement = card.elements.find(e => e.content.includes('will run tests'));
      expect(hintElement).toBeDefined();
      expect(hintElement!.content).toContain('_下一步: will run tests_');
    });
  });

  describe('reportNow', () => {
    it('should send a progress card immediately', async () => {
      reporter.start('task-1', ['Step A', 'Step B']);
      reporter.updateStep(0, 'Analyzing code');

      await reporter.reportNow();

      expect(sentCards).toHaveLength(1);
      const [card] = sentCards;
      expect(card.header.title.content).toBe('🔄 任务执行中');
      expect(card.header.template).toBe('blue');
    });

    it('should include current step detail', async () => {
      reporter.start('task-1', ['Step A', 'Step B']);
      reporter.updateStep(0, 'Analyzing code');

      await reporter.reportNow();

      const [card] = sentCards;
      const stepElement = card.elements.find(e => e.content.includes('Step A'));
      expect(stepElement).toBeDefined();
      expect(stepElement!.content).toContain('Analyzing code');
    });

    it('should include progress counter', async () => {
      reporter.start('task-1', ['Step A', 'Step B', 'Step C']);
      reporter.updateStep(0);
      reporter.updateStep(1);

      await reporter.reportNow();

      const [card] = sentCards;
      const counterElement = card.elements.find(e => e.content.includes('已处理'));
      expect(counterElement).toBeDefined();
      expect(counterElement!.content).toContain('1/3');
    });

    it('should not send card when not running', async () => {
      await reporter.reportNow();
      expect(sentCards).toHaveLength(0);
    });
  });

  describe('complete', () => {
    it('should send completion card', async () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);

      await reporter.complete('All done');

      expect(sentCards).toHaveLength(1);
      const [card] = sentCards;
      expect(card.header.title.content).toBe('✅ 任务完成');
      expect(card.header.template).toBe('green');
      expect(card.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('All done') }),
        ])
      );
    });

    it('should mark all steps as done', async () => {
      reporter.start('task-1', ['Step A', 'Step B', 'Step C']);
      reporter.updateStep(0);

      await reporter.complete('Done');

      const state = reporter.getState();
      expect(state.completedSteps).toBe(3);
    });

    it('should stop the timer', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.complete('Done');

      vi.advanceTimersByTime(120_000);
      // No additional cards from the timer
      expect(sentCards).toHaveLength(1);
    });

    it('should set status to completed', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.complete('Done');

      const state = reporter.getState();
      expect(state.status).toBe('completed');
    });

    it('should not send card when not running', async () => {
      await reporter.complete('Done');
      expect(sentCards).toHaveLength(0);
    });

    it('should only complete once', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.complete('Done');
      await reporter.complete('Done again');

      expect(sentCards).toHaveLength(1);
    });
  });

  describe('error', () => {
    it('should send error card', async () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);

      await reporter.error('Something went wrong');

      expect(sentCards).toHaveLength(1);
      const [card] = sentCards;
      expect(card.header.title.content).toBe('❌ 任务失败');
      expect(card.header.template).toBe('red');
      expect(card.elements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining('Something went wrong') }),
        ])
      );
    });

    it('should stop the timer', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.error('fail');

      vi.advanceTimersByTime(120_000);
      expect(sentCards).toHaveLength(1);
    });

    it('should set status to error', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.error('fail');

      const state = reporter.getState();
      expect(state.status).toBe('error');
    });

    it('should not send card when not running', async () => {
      await reporter.error('fail');
      expect(sentCards).toHaveLength(0);
    });
  });

  describe('stop', () => {
    it('should reset all state', () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);
      reporter.stop();

      const state = reporter.getState();
      expect(state.status).toBe('idle');
      expect(state.taskId).toBeNull();
      expect(state.totalSteps).toBe(0);
    });

    it('should stop the timer', () => {
      reporter.start('task-1', ['Step A']);
      reporter.stop();

      vi.advanceTimersByTime(120_000);
      expect(sentCards).toHaveLength(0);
    });
  });

  describe('getState', () => {
    it('should return idle state initially', () => {
      const state = reporter.getState();
      expect(state.status).toBe('idle');
      expect(state.taskId).toBeNull();
      expect(state.totalSteps).toBe(0);
      expect(state.completedSteps).toBe(0);
      expect(state.currentStep).toBeNull();
      expect(state.elapsed).toBe('0s');
    });

    it('should reflect running state with steps', () => {
      reporter.start('task-1', ['Step A', 'Step B']);
      reporter.updateStep(0);

      const state = reporter.getState();
      expect(state.status).toBe('running');
      expect(state.taskId).toBe('task-1');
      expect(state.totalSteps).toBe(2);
      expect(state.currentStep).toBe('Step A');
    });
  });

  describe('progress card format', () => {
    it('should match the Feishu card structure', async () => {
      reporter.start('task-1', ['Analyze code', 'Fix bug', 'Run tests']);
      reporter.updateStep(1, 'Fixing auth.service.ts');
      reporter.setNextStepHint('Run tests');

      await reporter.reportNow();

      const [card] = sentCards;
      // Structure validation
      expect(card.config).toEqual({ wide_screen_mode: true });
      expect(card.header.title.tag).toBe('plain_text');
      expect(card.header.title.content).toBe('🔄 任务执行中');
      expect(card.header.template).toBe('blue');

      // Elements are markdown
      for (const element of card.elements) {
        expect(element.tag).toBe('markdown');
        expect(element.content).toBeTruthy();
      }
    });

    it('should include step detail after em dash', async () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0, 'detail info');

      await reporter.reportNow();

      const [card] = sentCards;
      const stepElement = card.elements.find(e => e.content.includes('Step A'));
      expect(stepElement!.content).toBe('**当前步骤**: Step A — detail info');
    });

    it('should not include detail when not set', async () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);

      await reporter.reportNow();

      const [card] = sentCards;
      const stepElement = card.elements.find(e => e.content.includes('Step A'));
      expect(stepElement!.content).toBe('**当前步骤**: Step A');
    });

    it('should not include next hint when not set', async () => {
      reporter.start('task-1', ['Step A']);
      reporter.updateStep(0);

      await reporter.reportNow();

      const [card] = sentCards;
      const hintElement = card.elements.find(e => e.content.includes('下一步'));
      expect(hintElement).toBeUndefined();
    });

    it('should not include current step when no step is active', async () => {
      reporter.start('task-1', ['Step A']);

      await reporter.reportNow();

      const [card] = sentCards;
      const stepElement = card.elements.find(e => e.content.includes('当前步骤'));
      expect(stepElement).toBeUndefined();
    });
  });

  describe('timer behavior', () => {
    it('should stop sending cards after complete', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.complete('Done');

      vi.advanceTimersByTime(60_000);
      vi.advanceTimersByTime(60_000);

      expect(sentCards).toHaveLength(1);
    });

    it('should stop sending cards after error', async () => {
      reporter.start('task-1', ['Step A']);
      await reporter.error('fail');

      vi.advanceTimersByTime(60_000);

      expect(sentCards).toHaveLength(1);
    });

    it('should stop sending cards after stop', () => {
      reporter.start('task-1', ['Step A']);
      reporter.stop();

      vi.advanceTimersByTime(60_000);

      expect(sentCards).toHaveLength(0);
    });

    it('should restart timer on new start', () => {
      reporter.start('task-1', ['Step A']);
      reporter.stop();
      reporter.start('task-2', ['Step X']);

      vi.advanceTimersByTime(60_000);

      expect(sentCards).toHaveLength(1);
      expect(sentCards[0]?.header.title.content).toBe('🔄 任务执行中');
    });
  });
});

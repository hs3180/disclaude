/**
 * ProgressReporter - Periodic task progress notification.
 *
 * Sends progress cards at a fixed interval during long-running tasks,
 * giving users visibility into what the agent is doing.
 *
 * Design notes (Issue #857):
 * - Timer-based: first card is sent only after `intervalMs` elapses,
 *   so short tasks complete without any notification overhead.
 * - Tracks message count, current step, and elapsed time.
 * - Card format matches the Feishu interactive card spec.
 * - Can be evolved into an independent Reporter Agent (owner's later comment)
 *   by replacing the timer logic with an agent-driven decision loop.
 *
 * @module task/progress-reporter
 */

import { createLogger } from '../utils/logger.js';

const logger = createLogger('ProgressReporter');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback used to deliver a card to the user. */
export type SendCardFn = (card: Record<string, unknown>) => Promise<void>;

/** Configuration for ProgressReporter. */
export interface ProgressReporterConfig {
  /** Function that sends a card message to the user. */
  sendCard: SendCardFn;
  /** Interval in milliseconds between progress cards (default: 60 000). */
  intervalMs?: number;
}

/** Mutable progress state tracked during a turn. */
interface ProgressState {
  /** Human-readable description of what the agent is currently doing. */
  currentStep: string;
  /** Number of SDK messages processed so far this turn. */
  messageCount: number;
  /** Timestamp (ms) when the turn started. */
  startTime: number;
}

// ---------------------------------------------------------------------------
// ProgressReporter
// ---------------------------------------------------------------------------

/**
 * Periodic progress reporter for long-running agent tasks.
 *
 * Usage:
 * ```ts
 * const reporter = new ProgressReporter({ sendCard: (c) => feishu.sendCard(chatId, c) });
 * reporter.start();
 * // ... process messages, calling updateFromMessage() on each ...
 * reporter.stop();
 * ```
 */
export class ProgressReporter {
  private readonly sendCard: SendCardFn;
  private readonly intervalMs: number;

  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private state: ProgressState = {
    currentStep: '准备中...',
    messageCount: 0,
    startTime: 0,
  };

  constructor(config: ProgressReporterConfig) {
    this.sendCard = config.sendCard;
    this.intervalMs = config.intervalMs ?? 60_000;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /** Start periodic progress reporting. Safe to call multiple times. */
  start(): void {
    if (this.active) {return;}
    this.active = true;
    this.state = { currentStep: '准备中...', messageCount: 0, startTime: Date.now() };

    this.timer = setInterval(() => {
      this.report().catch((err) => {
        logger.error({ err }, 'Failed to send progress card');
      });
    }, this.intervalMs);

    logger.debug({ intervalMs: this.intervalMs }, 'ProgressReporter started');
  }

  /** Stop progress reporting. Safe to call when not active. */
  stop(): void {
    if (!this.active) {return;}
    this.active = false;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    logger.debug('ProgressReporter stopped');
  }

  /** Whether the reporter is currently active. */
  isActive(): boolean {
    return this.active;
  }

  // -----------------------------------------------------------------------
  // State updates
  // -----------------------------------------------------------------------

  /**
   * Feed an SDK message into the reporter so it can track progress.
   *
   * @param type - Message type from the SDK (`tool_use`, `text`, `tool_result`, etc.)
   * @param content - Optional content string (used to extract step descriptions).
   */
  updateFromMessage(type: string, content?: string): void {
    if (!this.active) {return;}
    this.state.messageCount++;

    if (type === 'tool_use') {
      this.state.currentStep = this.extractToolStep(content);
    } else if (type === 'tool_progress') {
      // Keep the existing step but note we're making progress
      if (content) {
        const line = content.split('\n')[0]?.substring(0, 60);
        if (line) {
          this.state.currentStep = line;
        }
      }
    }
  }

  /**
   * Manually override the current step description.
   * Useful when the caller has higher-level knowledge (e.g. "Phase 2/3").
   */
  setCurrentStep(step: string): void {
    this.state.currentStep = step;
  }

  // -----------------------------------------------------------------------
  // Card building
  // -----------------------------------------------------------------------

  /** Build a Feishu interactive card representing current progress. */
  buildCard(): Record<string, unknown> {
    const elapsed = Math.round((Date.now() - this.state.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

    return {
      config: { wide_screen_mode: true },
      header: {
        title: { content: '🔄 任务执行中', tag: 'plain_text' },
        template: 'blue',
      },
      elements: [
        { tag: 'markdown', content: `**当前步骤**: ${this.state.currentStep}` },
        { tag: 'markdown', content: `**已处理**: ${this.state.messageCount} 条消息` },
        { tag: 'markdown', content: `**耗时**: ${timeStr}` },
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Send one progress card. */
  private async report(): Promise<void> {
    const card = this.buildCard();
    await this.sendCard(card);
    logger.debug({ messageCount: this.state.messageCount }, 'Progress card sent');
  }

  /**
   * Extract a human-readable step description from a tool_use message.
   * Looks for tool name in common formats like "Using Read" or "Tool: Bash".
   */
  private extractToolStep(content?: string): string {
    if (!content) {return '调用工具中...';}

    // Try common patterns
    const patterns = [
      /Using (\w+):/i,
      /Tool: (\w+)/i,
      /(\w+)\(/,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match?.[1]) {
        const [, toolName] = match;
        // Try to extract a short description after the tool name
        const afterTool = content.substring(content.indexOf(toolName) + toolName.length);
        const desc = afterTool.match(/[:\s]+(.{1,40})/)?.[1]?.trim();
        return desc ? `${toolName} — ${desc}` : `正在使用 ${toolName}`;
      }
    }

    // Fallback: first 50 chars
    return content.length > 50 ? `${content.substring(0, 50)  }...` : content;
  }
}

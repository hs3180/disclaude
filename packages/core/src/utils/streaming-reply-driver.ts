/**
 * StreamingReplyDriver — drives the streaming-card lifecycle for one ChatAgent
 * turn (Issue #4399 / #4208 P2-b).
 *
 * Wraps the three streaming callbacks (`startStreaming` / `streamText` /
 * `finalizeStreaming`, contract from #4397/#4405) plus a `sendMessage` fallback.
 * State machine:
 *
 *   idle ──(first pushText)──▶ streaming | degraded
 *   streaming | degraded ──(finish)──▶ idle
 *
 * - **pushText(content)**: on the first call, asks the channel to
 *   `startStreaming`. If it returns an id → `streaming` (accumulate text,
 *   throttled `streamText` PATCHes). If it returns `null` (channel declined)
 *   OR throws → `degraded`, and ALL text (this chunk included) is delivered
 *   via `sendMessage` instead.
 * - **finish()**: if `streaming`, flush the final accumulated text *directly*
 *   to the card (NOT via the throttle — its trailing timer would be dropped by
 *   `finalize`) then `finalizeStreaming`. Idempotent; safe on every turn-exit
 *   path (normal result, stall, iterator error, abort). Before the direct
 *   flush it `drain()`s the throttle so a slow earlier fire-and-forget PATCH
 *   can't land after (and overwrite) the final content.
 *
 * **Reply-never-lost guarantee** (the hard contract from #4208/#4399):
 *  - start declines or throws → text goes to `sendMessage`;
 *  - finish() does a direct (awaited) final `streamText`; if *that* throws,
 *    `sendMessage` the full buffer.
 * Mid-stream PATCH failures are swallowed by the fire-and-forget throttle
 * (#4414 intentionally voids `emitFn`); they cost only an intermediate cosmetic
 * update, never the reply, because `finish()` always re-delivers the complete
 * text. The throttle's own 429 backoff (`note429`) is owned by the channel
 * client that implements `streamText`.
 *
 * No caller wired these callbacks before (#4397 left them as pure contract);
 * this driver is the Phase 2-b consumer. Pure utility — unit-testable in
 * isolation with mock callbacks (no live SDK required).
 */

import { StreamingThrottle } from './streaming-throttle.js';

/** Minimal logger surface the driver needs (pino-style `debug`/`warn`). */
export interface StreamingReplyLogger {
  debug: (obj: unknown, msg: string) => void;
  warn: (obj: unknown, msg: string) => void;
}

export interface StreamingReplyDriverOptions {
  chatId: string;
  /** Thread / parent message id forwarded to `startStreaming`. */
  parentMessageId?: string;
  /** Begin a streaming reply; returns a stream handle or null to degrade. */
  startStreaming: (chatId: string, parentMessageId?: string) => Promise<string | null>;
  /** Patch the in-flight card with the latest accumulated text (replace-semantics). */
  streamText: (id: string, text: string) => Promise<void>;
  /** Freeze the in-flight card; no further streamText calls for this id. */
  finalizeStreaming: (id: string) => Promise<void>;
  /** Fallback delivery used on degrade (reply never lost). */
  sendMessage: (chatId: string, content: string, threadRoot?: string) => Promise<void>;
  /** Min ms between PATCHes, forwarded to StreamingThrottle. Default 200. */
  minIntervalMs?: number;
  /** Inject a throttle (tests). */
  throttle?: StreamingThrottle;
  /** Inject a logger (defaults to silent). */
  logger?: StreamingReplyLogger;
}

type DriverState = 'idle' | 'streaming' | 'degraded';

const SILENT_LOGGER: StreamingReplyLogger = {
  debug: () => {},
  warn: () => {},
};

export class StreamingReplyDriver {
  private state: DriverState = 'idle';
  private streamId: string | null = null;
  private buffer = '';
  private throttle: StreamingThrottle | null = null;
  private readonly options: StreamingReplyDriverOptions;
  private readonly logger: StreamingReplyLogger;

  constructor(options: StreamingReplyDriverOptions) {
    this.options = options;
    this.logger = options.logger ?? SILENT_LOGGER;
  }

  /** True once streaming has started (an in-place card is in flight). */
  get isStreaming(): boolean {
    return this.state === 'streaming';
  }

  /** True if the channel declined streaming and we are on the sendMessage path. */
  get isDegraded(): boolean {
    return this.state === 'degraded';
  }

  /**
   * Push an assistant text chunk for this turn. Returns true if the content
   * was surfaced to the user (stream or sendMessage). Never throws — a
   * streaming failure degrades to sendMessage rather than losing the reply.
   */
  async pushText(content: string, threadRoot?: string): Promise<boolean> {
    if (this.state === 'idle') {
      await this.tryStart();
    }

    if (this.state === 'streaming') {
      this.buffer = this.buffer ? `${this.buffer}\n${content}` : content;
      // Fire-and-forget PATCH via the throttle (leading emits immediately;
      // trailing coalesces). The throttle voids emitFn, so our closure owns
      // error handling — swallow PATCH failures (finish() re-delivers anyway).
      this.throttle?.schedule(this.buffer);
      return true;
    }

    // degraded (start declined or threw): deliver via sendMessage.
    await this.safeSend(content, threadRoot);
    return true;
  }

  /**
   * Finalize the turn. Flushes the complete text to the card then freezes it.
   * Idempotent — safe to call on every exit path. Never throws.
   */
  async finish(threadRoot?: string): Promise<void> {
    if (this.state === 'streaming' && this.streamId) {
      const id = this.streamId;
      // Stop the throttle's trailing timer FIRST so its pending emission
      // (which finalize drops) doesn't race the direct flush below.
      this.throttle?.finalize();
      // Await any in-flight fire-and-forget PATCH so a slow earlier emission
      // can't land after — and thus overwrite, or hit a frozen — the direct
      // final flush below. Closes the narrow leading-vs-flush race noted in
      // the #4438 review (drain() uses allSettled, never throws).
      await this.throttle?.drain();
      try {
        if (this.buffer) {
          // Direct (awaited) final PATCH — guarantees the card holds the full
          // reply before we freeze it, regardless of what the throttle dropped.
          await this.options.streamText(id, this.buffer);
        }
        await this.options.finalizeStreaming(id);
      } catch (err) {
        this.logger.warn(
          { err, chatId: this.options.chatId },
          'streaming finish failed — falling back to sendMessage',
        );
        // Final delivery guarantee: send the whole reply via sendMessage.
        if (this.buffer) {
          await this.safeSend(this.buffer, threadRoot);
        }
      }
    }
    this.reset();
  }

  /** Attempt to start streaming; on decline/throw, transition to degraded. */
  private async tryStart(): Promise<void> {
    try {
      this.streamId = await this.options.startStreaming(
        this.options.chatId,
        this.options.parentMessageId,
      );
    } catch (err) {
      this.logger.warn(
        { err, chatId: this.options.chatId },
        'startStreaming threw — degrading to sendMessage',
      );
      this.streamId = null;
    }
    if (this.streamId) {
      this.state = 'streaming';
      // Capture the id so the fire-and-forget closure never reads a reset field.
      const id = this.streamId;
      this.throttle =
        this.options.throttle ??
        new StreamingThrottle(
          // Return the PATCH promise so the throttle can track it (drain()).
          // Own our error handling: a rejected streamText here must NOT become
          // an unhandled rejection — the .catch both swallows the error and
          // makes the returned promise always resolve, so finish()'s drain()
          // never throws. finish() re-delivers the complete text regardless.
          (text) =>
            this.options.streamText(id, text).catch((err) => {
              this.logger.debug(
                { err, chatId: this.options.chatId },
                'mid-stream streamText PATCH failed (will be re-delivered on finish)',
              );
            }),
          { minIntervalMs: this.options.minIntervalMs },
        );
    } else {
      this.state = 'degraded';
    }
  }

  /** sendMessage with swallow-on-failure so a flaky channel never masks the turn error. */
  private async safeSend(content: string, threadRoot?: string): Promise<void> {
    try {
      await this.options.sendMessage(this.options.chatId, content, threadRoot);
    } catch (err) {
      this.logger.warn(
        { err, chatId: this.options.chatId },
        'sendMessage fallback also failed — reply may be lost',
      );
    }
  }

  private reset(): void {
    this.state = 'idle';
    this.streamId = null;
    this.throttle = null;
    this.buffer = '';
  }
}

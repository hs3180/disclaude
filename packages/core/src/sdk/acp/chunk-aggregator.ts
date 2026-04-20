/**
 * Text Chunk Aggregator
 *
 * Buffers consecutive text/thinking chunks from ACP agent_message_chunk
 * and agent_thought_chunk events, flushing them as a single aggregated
 * message when:
 * - A non-text/non-thinking event arrives (message boundary)
 * - A debounce timer expires (configurable, default 500ms)
 * - The session is disposed (prompt completion/error/disconnect)
 *
 * This solves Issue #2532 where each token-level chunk was sent as
 * a separate message to Feishu, causing fragmented "碎片消息".
 *
 * @module sdk/acp/chunk-aggregator
 */

import type { AgentMessage } from '../types.js';

// ============================================================================
// 配置和类型
// ============================================================================

export interface TextChunkAggregatorOptions {
  /** Debounce interval in ms. Default: 500 */
  debounceMs?: number;
  /** Called when the debounce timer fires for a session */
  onFlush: (sessionId: string) => void;
}

interface SessionBuffer {
  text: string;
  thinking: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// TextChunkAggregator
// ============================================================================

/**
 * Buffers consecutive ACP text/thinking chunks and aggregates them.
 *
 * Each session has independent text and thinking buffers. When a non-chunk
 * event arrives (tool_call, plan, etc.), both buffers are flushed as
 * separate AgentMessages (thinking first, then text).
 *
 * @example
 * ```typescript
 * const aggregator = new TextChunkAggregator({
 *   debounceMs: 500,
 *   onFlush: (sessionId) => {
 *     const messages = aggregator.flush(sessionId);
 *     // push messages to consumer...
 *   },
 * });
 *
 * // Buffer text chunks
 * aggregator.addText('sess-1', 'Hello');
 * aggregator.addText('sess-1', ' world');
 *
 * // Flush on non-chunk event
 * const messages = aggregator.flush('sess-1');
 * // messages: [{ type: 'text', content: 'Hello world', role: 'assistant' }]
 * ```
 */
export class TextChunkAggregator {
  private readonly buffers = new Map<string, SessionBuffer>();
  private readonly debounceMs: number;
  private readonly onFlush: (sessionId: string) => void;

  constructor(options: TextChunkAggregatorOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.onFlush = options.onFlush;
  }

  /** Add text from an agent_message_chunk to the buffer */
  addText(sessionId: string, text: string): void {
    if (!text) {return;}
    const buf = this.getOrCreateBuffer(sessionId);
    buf.text += text;
    this.resetTimer(sessionId);
  }

  /** Add text from an agent_thought_chunk to the buffer */
  addThinking(sessionId: string, text: string): void {
    if (!text) {return;}
    const buf = this.getOrCreateBuffer(sessionId);
    buf.thinking += text;
    this.resetTimer(sessionId);
  }

  /**
   * Flush all buffered content for a session.
   * Returns AgentMessages for any non-empty buffers (thinking first, then text).
   */
  flush(sessionId: string): AgentMessage[] {
    this.clearTimer(sessionId);
    const buf = this.buffers.get(sessionId);
    if (!buf) {return [];}

    this.buffers.delete(sessionId);
    const messages: AgentMessage[] = [];

    if (buf.thinking) {
      messages.push({
        type: 'thinking',
        content: buf.thinking,
        role: 'assistant',
      });
    }

    if (buf.text) {
      messages.push({
        type: 'text',
        content: buf.text,
        role: 'assistant',
      });
    }

    return messages;
  }

  /** Check if a session has any buffered content */
  hasContent(sessionId: string): boolean {
    const buf = this.buffers.get(sessionId);
    if (!buf) {return false;}
    return buf.text.length > 0 || buf.thinking.length > 0;
  }

  /** Get list of session IDs with buffered content */
  getActiveSessionIds(): string[] {
    return [...this.buffers.keys()];
  }

  /**
   * Dispose a session without flushing.
   * Use flush() first if you want to deliver buffered content.
   */
  dispose(sessionId: string): void {
    this.clearTimer(sessionId);
    this.buffers.delete(sessionId);
  }

  /** Dispose all sessions without flushing */
  disposeAll(): void {
    for (const [sessionId] of this.buffers) {
      this.clearTimer(sessionId);
    }
    this.buffers.clear();
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private getOrCreateBuffer(sessionId: string): SessionBuffer {
    let buf = this.buffers.get(sessionId);
    if (!buf) {
      buf = { text: '', thinking: '', timer: null };
      this.buffers.set(sessionId, buf);
    }
    return buf;
  }

  private resetTimer(sessionId: string): void {
    this.clearTimer(sessionId);
    const buf = this.getOrCreateBuffer(sessionId);
    buf.timer = setTimeout(() => {
      this.onFlush(sessionId);
    }, this.debounceMs);
  }

  private clearTimer(sessionId: string): void {
    const buf = this.buffers.get(sessionId);
    if (buf?.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
  }
}

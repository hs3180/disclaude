/**
 * Sliding window rate limiter for A2A task delegation.
 *
 * Tracks message counts per source within a configurable time window.
 * Used to prevent any single agent from flooding another with tasks.
 *
 * @see Issue #3334 (A2A messaging — Agent-to-Agent task delegation)
 */

import { DEFAULT_A2A_RATE_LIMIT, type A2ARateLimitConfig } from './a2a-types.js';

/**
 * Sliding window rate limiter for A2A messages.
 *
 * Tracks per-source message counts using a sliding time window.
 * When a source exceeds the limit within the window, further messages are rejected.
 */
export class A2ARateLimiter {
  private readonly maxMessages: number;
  private readonly windowMs: number;

  /** Per-source timestamp arrays (source → list of message timestamps) */
  private readonly timestamps = new Map<string, number[]>();

  constructor(config?: Partial<A2ARateLimitConfig>) {
    const full = { ...DEFAULT_A2A_RATE_LIMIT, ...config };
    this.maxMessages = full.maxMessagesPerWindow;
    this.windowMs = full.windowMs;
  }

  /**
   * Check if a source is allowed to send a message and record it.
   *
   * @param source - The source identifier (e.g., 'chat:oc_xxx')
   * @returns true if the message is allowed, false if rate limited
   */
  check(source: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let entries = this.timestamps.get(source);
    if (!entries) {
      entries = [];
      this.timestamps.set(source, entries);
    }

    // Remove expired entries
    while (entries.length > 0 && (entries[0] as number) < cutoff) {
      entries.shift();
    }

    if (entries.length >= this.maxMessages) {
      return false;
    }

    entries.push(now);
    return true;
  }

  /**
   * Get the current count for a source within the window.
   * Useful for testing and monitoring.
   */
  getCount(source: string): number {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const entries = this.timestamps.get(source);
    if (!entries) {return 0;}
    return entries.filter((ts) => ts >= cutoff).length;
  }

  /**
   * Reset rate limiter state. Useful for testing.
   */
  reset(): void {
    this.timestamps.clear();
  }
}

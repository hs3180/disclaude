/**
 * Per-chat last-failure registry (Issue #5400, PR A).
 *
 * ChatAgent records every user-visible failure context here so the `/issue`
 * feedback entry can offer "report the most recent failure of this chat"
 * without reading logs or replaying the conversation. The registry keeps only
 * the LAST record per chat — a new failure supersedes the old one — and is
 * bounded so a long-running service cannot grow it without limit.
 *
 * Records are already sanitized by the producer (createFailureContext runs
 * sanitizeDiagnosticText on every free-text field); no raw secrets enter here.
 */

/** The subset of a ChatAgent failure context that /issue reporting needs. */
export interface ChatFailureRecord {
  chatId: string;
  diagnosticId: string;
  /** Failure classification, e.g. agent-loop-error / provider-turn-failed. */
  failureClass: string;
  /** Sanitized error detail. */
  detail: string;
  /** ISO timestamp of the failure. */
  timestamp: string;
  backend?: string;
  provider?: string;
  sessionId?: string;
  /** Thread root the failure was reported in ('none' when not thread-scoped). */
  threadRootId?: string;
  sourceMessageId?: string;
}

/** Default cap on tracked chats; the least recently updated chat is dropped. */
const DEFAULT_MAX_CHATS = 256;

export class ChatFailureRegistry {
  private readonly records = new Map<string, ChatFailureRecord>();
  private readonly maxChats: number;

  constructor(maxChats = DEFAULT_MAX_CHATS) {
    this.maxChats = maxChats;
  }

  /** Record `failure` as the last failure of its chat (insertion order = recency). */
  record(failure: ChatFailureRecord): void {
    if (!failure.chatId || !failure.diagnosticId) {
      return;
    }
    this.records.delete(failure.chatId);
    this.records.set(failure.chatId, failure);
    while (this.records.size > this.maxChats) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.records.delete(oldest);
    }
  }

  /** Last recorded failure of the chat, if any. */
  get(chatId: string): ChatFailureRecord | undefined {
    return this.records.get(chatId);
  }

  /** Drop a chat's record (used after a successful report or explicit dismiss). */
  clear(chatId: string): void {
    this.records.delete(chatId);
  }
}

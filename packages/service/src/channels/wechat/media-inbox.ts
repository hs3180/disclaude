import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatUpdate } from './types.js';
import { WeChatMediaError } from './media-error.js';
import { MAX_MEDIA_INBOX, validMediaInbox, type MediaInboxEntry } from './media-inbox-state.js';

const logger = createLogger('WeChatMediaInbox');
const MAX_FAILURES = 3;
const RETRY_MS = 5_000;
const RETENTION_MS = 24 * 60 * 60_000;
type Attachments = NonNullable<IncomingMessage['attachments']>;
export type { MediaInboxEntry } from './media-inbox-state.js';

/** One account-owned worker; polling never waits for media network I/O. */
export class WeChatMediaInbox {
  private readonly entries = new Map<string, MediaInboxEntry>();
  private readonly ready = new Set<string>();
  private wake?: () => void;
  constructor(entries: MediaInboxEntry[] = [], private readonly persist: () => Promise<void>,
    private readonly resolve: (update: WeChatUpdate, signal: AbortSignal, cached?: Attachments) => Promise<IncomingMessage | null>,
    private readonly accept: (message: IncomingMessage) => Promise<void>) {
    if (!validMediaInbox(entries)) { throw new Error('Invalid WeChat media recovery state'); }
    for (const value of structuredClone(entries)) {
      if (value.state === 'dispatching') { value.state = 'uncertain'; value.reported = false; }
      this.entries.set(value.id, value); this.ready.add(value.id);
    }
  }
  snapshot(): MediaInboxEntry[] { return structuredClone([...this.entries.values()]); }
  has(id: string): boolean { return this.entries.has(id); }

  async enqueue(update: WeChatUpdate): Promise<void> {
    const id = update.message_id ?? update.msg_id ?? update.client_id;
    if (!id) { throw new Error('WeChat media has no message identity'); }
    if (!this.entries.has(id)) {
      if (this.entries.size >= MAX_MEDIA_INBOX) {
        const terminal = [...this.entries.values()].find(e => e.state === 'failed' && e.reported);
        if (terminal) { this.entries.delete(terminal.id); this.ready.delete(terminal.id); }
      }
      if (this.entries.size >= MAX_MEDIA_INBOX) { throw new Error('WeChat media recovery queue is full; update was not acknowledged'); }
      const entry: MediaInboxEntry = { id, recoveryId: randomUUID(), update: structuredClone(update), state: 'pending',
        failures: 0, nextAt: Date.now(), expiresAt: Date.now() + RETENTION_MS };
      if (!validMediaInbox([entry])) { throw new Error('Invalid WeChat media identity or payload'); }
      this.entries.set(id, entry);
    }
    // Even a repeated update retries a failed checkpoint before cursor ACK.
    await this.persist(); this.ready.add(id); this.wake?.();
  }

  private wait(signal: AbortSignal, ms?: number): Promise<void> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer) { clearTimeout(timer); }
        signal.removeEventListener('abort', finish);
        if (this.wake === finish) { this.wake = undefined; }
        resolve();
      };
      this.wake = finish;
      signal.addEventListener('abort', finish, { once: true });
      if (ms !== undefined) { timer = setTimeout(finish, Math.max(1, ms)); }
      if (signal.aborted) { finish(); }
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const now = Date.now();
        const values = [...this.entries.values()].filter(e => this.ready.has(e.id));
        const entry = values.find(e => e.expiresAt <= now || (e.state === 'pending' && e.nextAt <= now)
          || ((e.state === 'failed' || e.state === 'uncertain') && !e.reported));
        if (!entry) {
          const next = Math.min(...values.map(e => e.state === 'pending' ? Math.min(e.nextAt, e.expiresAt) : e.expiresAt));
          await this.wait(signal, Number.isFinite(next) ? next - now : undefined); continue;
        }
        if (entry.expiresAt <= now) {
          logger.warn({ event: 'media_recovery_expired', messageId: entry.id, recoveryId: entry.recoveryId, state: entry.state }, 'WeChat media recovery record expired');
          this.entries.delete(entry.id); this.ready.delete(entry.id); await this.persist(); continue;
        }
        if (entry.state === 'uncertain') {
          logger.error({ event: 'media_dispatch_uncertain', messageId: entry.id, recoveryId: entry.recoveryId }, 'Media task admission is uncertain; original request will not be replayed');
          entry.reported = true; await this.persist(); continue;
        }
        if (entry.state === 'failed') {
          // Notification has its own identity and is attempted at most once.
          entry.reported = true; await this.persist();
          if (signal.aborted) { return; }
          const peer = entry.update.from_user_id;
          if (!peer) { throw new Error('WeChat media recovery has no bound peer'); }
          await this.accept({ messageId: `media-failure:${entry.recoveryId}`, chatId: peer, userId: peer,
            messageType: 'text', timestamp: now,
            content: '[Attachment processing failed; automatic recovery stopped. The original attachment was not delivered. Do not treat the original request as completed.]',
            metadata: { attachmentRecovery: { state: 'failed', originalMessageId: entry.id, failures: entry.failures, recoveryId: entry.recoveryId } } });
          continue;
        }
        entry.nextAt = now + RETRY_MS * 2 ** entry.failures;
        let message: IncomingMessage | null;
        try {
          if (entry.attachments) {
            const files = await Promise.all(entry.attachments.map(a => stat(a.filePath).then(s => s.isFile()).catch(() => false)));
            if (files.some(exists => !exists)) { entry.attachments = undefined; }
          }
          message = await this.resolve(entry.update, signal, entry.attachments);
          if (signal.aborted) { return; }
          if (!message?.attachments?.length) { throw new Error('Media resolver returned no attachments'); }
        } catch (error) {
          if (signal.aborted) { return; }
          entry.failures++;
          if (entry.failures >= MAX_FAILURES || (error instanceof WeChatMediaError && !error.retryable)) { entry.state = 'failed'; }
          logger.warn({ event: 'media_recovery_failed', messageId: entry.id, recoveryId: entry.recoveryId, failures: entry.failures,
            state: entry.state, ...(error instanceof WeChatMediaError ? error.detail : { stage: 'unknown' }) }, 'WeChat media processing failed');
          await this.persist(); continue;
        }
        entry.attachments = message.attachments;
        await this.persist(); // Keep the successful download across restart/dispatch failure.
        if (signal.aborted) { return; }
        entry.state = 'dispatching';
        try { await this.persist(); } catch (error) { entry.state = 'pending'; throw error; }
        if (signal.aborted) { entry.state = 'uncertain'; return; }
        try {
          await this.accept({ ...message,
            content: `[Attachments from an earlier message are now available. Later user instructions take precedence; do not restart or repeat already completed work.]\n\n${message.content}`,
            metadata: { ...message.metadata, attachmentRecovery: { state: 'completed', failures: entry.failures,
              recoveryId: entry.recoveryId, originalMessageId: entry.id, originalTimestamp: message.timestamp } } });
        } catch {
          entry.state = 'uncertain'; if (signal.aborted) { return; } await this.persist(); continue;
        }
        if (signal.aborted) { entry.state = 'uncertain'; return; }
        this.entries.delete(entry.id); this.ready.delete(entry.id); await this.persist();
      } catch {
        if (signal.aborted) { return; }
        logger.error({ event: 'media_recovery_checkpoint_or_handoff_failed' }, 'WeChat media recovery could not finish; retained for inspection');
        await this.wait(signal, RETRY_MS);
      }
    }
  }
}

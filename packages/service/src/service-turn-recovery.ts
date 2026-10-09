import {
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { createLogger } from '@disclaude/core';

const logger = createLogger('ServiceTurnRecovery');
const STORE_VERSION = 1;
const MAX_RETAINED_TURNS = 1_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

export interface ServiceTurnStart {
  chatId: string;
  sessionKey: string;
  traceId: string;
  runId: string;
  sourceMessageId: string;
  threadRootId?: string;
  startedAt: number;
}

export interface InterruptedServiceTurn extends ServiceTurnStart {
  state: 'interrupted_by_service_restart';
  interruptionCause: 'service_restart';
  interruptedAt: number;
  noticeDeliveredAt?: number;
  noticeMessageId?: string;
}

interface ActiveServiceTurn extends ServiceTurnStart {
  state: 'active';
}

type StoredServiceTurn = ActiveServiceTurn | InterruptedServiceTurn;

interface StoreDocument {
  version: 1;
  turns: StoredServiceTurn[];
}

function isServiceTurn(value: unknown): value is StoredServiceTurn {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const turn = value as Record<string, unknown>;
  const common =
    typeof turn.chatId === 'string' &&
    typeof turn.sessionKey === 'string' &&
    typeof turn.traceId === 'string' &&
    typeof turn.runId === 'string' &&
    typeof turn.sourceMessageId === 'string' &&
    typeof turn.startedAt === 'number' && Number.isFinite(turn.startedAt) &&
    (turn.threadRootId === undefined || typeof turn.threadRootId === 'string');
  if (!common) {
    return false;
  }
  if (turn.state === 'active') {
    return true;
  }
  return (
    turn.state === 'interrupted_by_service_restart' &&
    turn.interruptionCause === 'service_restart' &&
    typeof turn.interruptedAt === 'number' && Number.isFinite(turn.interruptedAt) &&
    (turn.noticeDeliveredAt === undefined ||
      (typeof turn.noticeDeliveredAt === 'number' && Number.isFinite(turn.noticeDeliveredAt))) &&
    (turn.noticeMessageId === undefined || typeof turn.noticeMessageId === 'string')
  );
}

/**
 * Small durable journal used to report turns that were live when the service
 * stopped. It stores only correlation IDs and timestamps, never message text.
 * The service process lock guarantees a single writer.
 */
export class ServiceTurnRecoveryStore {
  private readonly turns = new Map<string, StoredServiceTurn>();
  private readonly noticesInFlight = new Map<string, Promise<void>>();

  constructor(private readonly filePath: string) {}

  /** Load the prior process journal and persist an interruption outcome for any live turns. */
  initialize(now = Date.now()): InterruptedServiceTurn[] {
    this.turns.clear();
    if (existsSync(this.filePath)) {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (
        !raw ||
        typeof raw !== 'object' ||
        (raw as StoreDocument).version !== STORE_VERSION ||
        !Array.isArray((raw as StoreDocument).turns) ||
        !(raw as StoreDocument).turns.every(isServiceTurn)
      ) {
        throw new Error('Service turn recovery journal has an unsupported or invalid format');
      }
      for (const turn of (raw as StoreDocument).turns) {
        if (this.turns.has(turn.runId)) { throw new Error('Duplicate runId in service turn recovery journal'); }
        this.turns.set(turn.runId, { ...turn });
      }
    }

    const interrupted = this.interruptWhere(() => true, now);
    const pruned = this.prune(now);
    if (interrupted.length > 0 || pruned) {
      this.persist();
      for (const turn of interrupted) {
        logger.warn(
          {
            event: 'agent_turn',
            state: turn.state,
            interruptionCause: turn.interruptionCause,
            user_visible: false,
            chatId: turn.chatId,
            sessionKey: turn.sessionKey,
            traceId: turn.traceId,
            runId: turn.runId,
            sourceMessageId: turn.sourceMessageId,
          },
          'Reconciled an unfinished agent turn from the previous service process'
        );
      }
    }
    return interrupted;
  }

  /** Persist before a message is pushed to the model, so side effects are never untracked. */
  startTurn(turn: ServiceTurnStart): void {
    if (this.turns.has(turn.runId)) {
      throw new Error('Duplicate service turn runId');
    }
    this.turns.set(turn.runId, { ...turn, state: 'active' });
    try {
      this.persist();
    } catch (error) {
      this.turns.delete(turn.runId);
      throw error;
    }
  }

  /** Clear only active records; an already durable interruption must not be erased by late teardown. */
  completeTurn(runId: string): void {
    const turn = this.turns.get(runId);
    if (!turn || turn.state !== 'active') {
      return;
    }
    this.turns.delete(runId);
    try {
      this.persist();
    } catch (error) {
      this.turns.set(runId, turn);
      throw error;
    }
  }

  /** Persist restart interruption outcomes for every active turn in one agent session. */
  interruptSession(sessionKey: string, now = Date.now()): InterruptedServiceTurn[] {
    const previous = new Map(
      [...this.turns.entries()].filter(
        ([, turn]) => turn.sessionKey === sessionKey && turn.state === 'active'
      )
    );
    const interrupted = this.interruptWhere((turn) => turn.sessionKey === sessionKey, now);
    if (interrupted.length > 0) {
      try {
        this.persist();
      } catch (error) {
        for (const [runId, turn] of previous) {
          this.turns.set(runId, turn);
        }
        throw error;
      }
    }
    return interrupted;
  }

  getPendingNotifications(sessionKey?: string): InterruptedServiceTurn[] {
    return [...this.turns.values()]
      .filter(
        (turn): turn is InterruptedServiceTurn =>
          (sessionKey === undefined || turn.sessionKey === sessionKey) &&
          turn.state === 'interrupted_by_service_restart' &&
          turn.noticeDeliveredAt === undefined
      )
      .map((turn) => ({ ...turn }));
  }

  /** Reconcile on startup and on the next available session delivery path.
   * A timeout bounds the caller, not the send: keep its in-flight claim until
   * it settles and acknowledge late success instead of sending a duplicate.
   */
  async deliverPendingNotifications(
    send: (chatId: string, content: string, threadRootId?: string) => Promise<unknown>,
    options: { sessionKey?: string; timeoutMs?: number } = {},
  ): Promise<void> {
    const operations = this.getPendingNotifications(options.sessionKey).map(record => {
      const existing = this.noticesInFlight.get(record.runId);
      if (existing) { return existing; }
      const content =
        `⏹️ 服务重启时请求尚未完成，现已标记为中断（消息 ID：\`${record.sourceMessageId}\`，运行 ID：\`${record.runId}\`）。` +
        '系统没有自动重放，以免重复执行操作。请先核对已发生的操作，再决定是否重新提交或继续。';
      const operation = Promise.resolve()
        .then(() => send(record.chatId, content, record.threadRootId))
        .then(receipt => {
          // REST's buffered reply uses the incoming request ID, not a
          // delivery acknowledgement. Its buffer disappears at shutdown;
          // keep the outcome for the next live response path instead.
          if (typeof receipt !== 'string' || !receipt || receipt === record.sourceMessageId) {
            throw new Error('Channel returned no delivery receipt for the restart notice');
          }
          this.markNotificationsDelivered([record.runId], Date.now(), receipt);
          logger.info({ ...record, event: 'agent_turn', state: 'interruption_notice_delivered',
            user_visible: true }, 'Delivered service-restart interruption outcome');
        })
        .catch(error => {
          logger.warn({ err: error, ...record }, 'Service-restart notice delivery failed; outcome remains pending');
        })
        .finally(() => { this.noticesInFlight.delete(record.runId); });
      this.noticesInFlight.set(record.runId, operation);
      return operation;
    });
    if (operations.length === 0) { return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(operations),
        new Promise<void>(resolve => { timer = setTimeout(() => {
          logger.warn({ sessionKey: options.sessionKey, timeoutMs: options.timeoutMs ?? 3_000 },
            'Service-restart notice delivery still pending after bounded wait');
          resolve();
        }, Math.max(1, options.timeoutMs ?? 3_000)); }),
      ]);
    } finally {
      if (timer) { clearTimeout(timer); }
    }
  }

  /** Mark notice delivery only after the channel confirms the send. */
  markNotificationsDelivered(runIds: string[], now = Date.now(), noticeMessageId?: string): void {
    const changedTurns = new Map<string, InterruptedServiceTurn>();
    for (const runId of runIds) {
      const turn = this.turns.get(runId);
      if (
        turn?.state === 'interrupted_by_service_restart' &&
        turn.noticeDeliveredAt === undefined
      ) {
        changedTurns.set(runId, turn);
        this.turns.set(runId, { ...turn, noticeDeliveredAt: now, ...(noticeMessageId ? { noticeMessageId } : {}) });
      }
    }
    const snapshot = new Map(this.turns);
    const pruned = this.prune(now);
    if (changedTurns.size > 0 || pruned) {
      try {
        this.persist();
      } catch (error) {
        this.turns.clear();
        for (const [runId, turn] of snapshot) { this.turns.set(runId, turn); }
        for (const [runId, turn] of changedTurns) {
          this.turns.set(runId, turn);
        }
        throw error;
      }
    }
  }

  private interruptWhere(
    predicate: (turn: StoredServiceTurn) => boolean,
    now: number
  ): InterruptedServiceTurn[] {
    const interrupted: InterruptedServiceTurn[] = [];
    for (const [runId, turn] of this.turns) {
      if (turn.state !== 'active' || !predicate(turn)) {
        continue;
      }
      const record: InterruptedServiceTurn = {
        ...turn,
        state: 'interrupted_by_service_restart',
        interruptionCause: 'service_restart',
        interruptedAt: now,
      };
      this.turns.set(runId, record);
      interrupted.push({ ...record });
    }
    return interrupted;
  }

  private prune(now: number): boolean {
    const previousSize = this.turns.size;
    for (const [runId, turn] of this.turns) {
      if (
        turn.state === 'interrupted_by_service_restart' &&
        turn.noticeDeliveredAt !== undefined &&
        now - turn.noticeDeliveredAt > RETENTION_MS
      ) {
        this.turns.delete(runId);
      }
    }
    if (this.turns.size > MAX_RETAINED_TURNS) {
      const delivered = [...this.turns.values()]
        .filter(
          (turn): turn is InterruptedServiceTurn =>
            turn.state === 'interrupted_by_service_restart' && turn.noticeDeliveredAt !== undefined
        )
        .sort((a, b) => (a.noticeDeliveredAt ?? 0) - (b.noticeDeliveredAt ?? 0));
      while (this.turns.size > MAX_RETAINED_TURNS && delivered.length > 0) {
        const oldest = delivered.shift();
        if (!oldest) {
          break;
        }
        this.turns.delete(oldest.runId);
      }
    }
    return this.turns.size !== previousSize;
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    const document: StoreDocument = {
      version: STORE_VERSION,
      turns: [...this.turns.values()].sort((a, b) => a.startedAt - b.startedAt),
    };
    const fd = openSync(temporaryPath, 'w', 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(document), 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, this.filePath);
    try {
      const directoryFd = openSync(directory, 'r');
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      logger.warn(
        { err: error, filePath: this.filePath },
        'Could not fsync service turn journal directory'
      );
    }
  }
}

/**
 * Voice Orchestrator — file-backed intent snapshot store (M1 persistence).
 *
 * Layers durability on top of the in-memory {@link IntentSnapshotStore} that M0
 * shipped: every mutating call persists the affected session as JSON under a
 * directory (one file per session), and construction reloads whatever it finds.
 * This keeps the frozen canonical (the object N agents read) and the results
 * region across process restarts, so cross-restart delivery still matches the
 * canonical it was started from — same contract, durable backing.
 *
 * Write strategy: writes are serialized through a per-store chain (rapid
 * mutations coalesce in order, each writing the state current at write time)
 * and use serialize-then-rename, so a crash mid-write never leaves a truncated
 * session file behind. Persistence failures never roll the in-memory mutation
 * back; they are surfaced once through {@link FileIntentSnapshotStore.drain}.
 *
 * Contract: await {@link FileIntentSnapshotStore.ready} before mutating — the
 * constructor reloads persisted sessions asynchronously.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IntentSnapshotStore, type IntentSnapshotStoreOptions } from './store.js';
import type { IntentSnapshot } from './types.js';

export interface FileIntentSnapshotStoreOptions extends IntentSnapshotStoreOptions {
  /** Directory holding one `<sessionId>.json` file per session. Created if missing. */
  dir: string;
}

/** Thrown when a session file exists but does not decode into a snapshot. */
export class CorruptSnapshotError extends Error {
  constructor(
    public readonly file: string,
    public readonly cause: unknown,
  ) {
    super(`Corrupt intent snapshot file: ${file} (${String(cause)})`);
    this.name = 'CorruptSnapshotError';
  }
}

export class FileIntentSnapshotStore extends IntentSnapshotStore {
  private readonly dir: string;
  /** Serializes persistence writes; never rejects (errors land in lastPersistError). */
  private writeChain: Promise<void> = Promise.resolve();
  private lastPersistError: unknown;

  /** Resolves once persisted sessions have been reloaded from disk. */
  readonly ready: Promise<void>;

  constructor(opts: FileIntentSnapshotStoreOptions) {
    super(opts);
    this.dir = opts.dir;
    this.ready = this.reload();
  }

  // --- lifecycle ---

  /** Create a fresh drafting session and persist it. Rejects unsafe session ids. */
  async createSessionAndPersist(sessionId?: string): Promise<IntentSnapshot> {
    await this.ready;
    if (sessionId !== undefined) {
      assertSafeSessionId(sessionId);
    }
    const snap = this.createSession(sessionId);
    await this.flush(snap.sessionId);
    return snap;
  }

  /** Reload every session file currently present in the directory. */
  async reload(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const files = await readdir(this.dir);
    for (const name of files) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const file = join(this.dir, name);
      let snap: IntentSnapshot;
      try {
        snap = JSON.parse(await readFile(file, 'utf8')) as IntentSnapshot;
        // The decoded id must be plain and match the file it came from, else a
        // crafted file could smuggle a session id that escapes the directory.
        assertSafeSessionId(snap.sessionId);
        if (snap.sessionId !== name.slice(0, -'.json'.length)) {
          throw new Error(`sessionId ${snap.sessionId} does not match file ${name}`);
        }
      } catch (err) {
        throw new CorruptSnapshotError(file, err);
      }
      this.restoreSession(snap);
    }
  }

  /**
   * Await all in-flight persistence writes (graceful shutdown, tests). Rejects
   * once with the most recent persistence failure, if any, then clears it.
   */
  async drain(): Promise<void> {
    await this.writeChain;
    if (this.lastPersistError !== undefined) {
      const err = this.lastPersistError;
      this.lastPersistError = undefined;
      throw err;
    }
  }

  // --- persistence ---

  /**
   * Queue a persist of one session's current state. Runs after any previously
   * queued write, so concurrent mutations never interleave file writes and the
   * last write always carries the latest state.
   */
  private flush(sessionId: string): Promise<void> {
    const attempt = () => this.persist(this.getSession(sessionId));
    const write = this.writeChain.then(attempt, attempt);
    this.writeChain = write.catch((err: unknown) => {
      this.lastPersistError = err;
    });
    return write;
  }

  /**
   * Atomically persist one session: write `<id>.json.tmp` then rename over the
   * target, so the file on disk is always a complete snapshot.
   */
  private async persist(snapshot: IntentSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.fileFor(snapshot.sessionId);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await rename(tmp, target);
  }

  private fileFor(sessionId: string): string {
    return join(this.dir, `${assertSafeSessionId(sessionId)}.json`);
  }

  // --- mutating overrides: mutate in memory first, then queue persistence ---

  override appendDraft(...args: Parameters<IntentSnapshotStore['appendDraft']>) {
    const out = super.appendDraft(...args);
    void this.flush(args[0]);
    return out;
  }

  override promoteCandidate(...args: Parameters<IntentSnapshotStore['promoteCandidate']>) {
    const out = super.promoteCandidate(...args);
    void this.flush(args[0]);
    return out;
  }

  override freeze(...args: Parameters<IntentSnapshotStore['freeze']>) {
    const out = super.freeze(...args);
    void this.flush(args[0]);
    return out;
  }

  override appendResult(...args: Parameters<IntentSnapshotStore['appendResult']>) {
    const out = super.appendResult(...args);
    void this.flush(args[0]);
    return out;
  }

  override markDelivered(...args: Parameters<IntentSnapshotStore['markDelivered']>) {
    const out = super.markDelivered(...args);
    void this.flush(args[0]);
    return out;
  }
}

/** Session ids are ours (createSession default is a UUID); refuse anything that could escape the directory. */
function assertSafeSessionId(sessionId: string): string {
  if (!/^[\w.-]+$/.test(sessionId)) {
    throw new Error(`unsafe sessionId (path separators or empty): ${sessionId}`);
  }
  return sessionId;
}

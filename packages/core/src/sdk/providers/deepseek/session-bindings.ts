import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DshSessionBinding {
  sessionId: string;
  resume: boolean;
  scope?: string;
}

interface StoredBinding {
  version: 1;
  sessionId: string;
  sessionKey: string;
  cwd: string;
  state: 'fresh' | 'uncertain' | 'ready';
}

/** Harness conversation references only; Notebook identity and jobs live elsewhere. */
export class DshSessionBindings {
  private readonly directory: string;

  constructor(dshHome: string) {
    this.directory = join(dshHome, 'disclaude', 'session-bindings');
  }

  reserve(sessionKey: string | undefined, cwd: string): DshSessionBinding {
    if (sessionKey === undefined) {
      return { sessionId: `disclaude-${randomUUID()}`, resume: false };
    }
    if (!sessionKey) {
      throw new TypeError('DSH sessionKey must be non-empty');
    }
    cwd = resolve(cwd);
    const scope = createHash('sha256')
      .update(JSON.stringify([sessionKey, cwd]))
      .digest('hex');
    let record = this.read(scope);
    if (record && (record.sessionKey !== sessionKey || record.cwd !== cwd)) {
      throw new Error('DSH session binding scope mismatch');
    }
    if (!record) {
      record = {
        version: 1,
        sessionId: `disclaude-${randomUUID()}`,
        sessionKey,
        cwd,
        state: 'fresh',
      };
      this.write(scope, record);
    }
    return { scope, sessionId: record.sessionId, resume: record.state !== 'fresh' };
  }

  /** Persist the ambiguous opening window before sending a create/resume request. */
  opening(binding: DshSessionBinding): void {
    this.update(binding, 'uncertain');
  }

  opened(binding: DshSessionBinding): void {
    this.update(binding, 'ready');
  }

  /** Reset drops only our reference, preserving DSH history and Jupyter resources. */
  forget(sessionKey: string): void {
    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry)) {
        continue;
      }
      const scope = entry.slice(0, -5);
      if (this.read(scope)?.sessionKey === sessionKey) {
        rmSync(this.path(scope));
      }
    }
  }

  private update(binding: DshSessionBinding, state: StoredBinding['state']): void {
    if (!binding.scope) {
      return;
    }
    const record = this.read(binding.scope);
    // A delayed old query must not recreate a reset/replaced binding.
    if (!record || record.sessionId !== binding.sessionId) {
      return;
    }
    this.write(binding.scope, { ...record, state });
  }

  private read(scope: string): StoredBinding | undefined {
    let text: string;
    try {
      text = readFileSync(this.path(scope), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
    const record = JSON.parse(text) as Partial<StoredBinding>;
    if (
      record.version !== 1 ||
      typeof record.sessionId !== 'string' ||
      !/^disclaude-[a-f0-9-]{36}$/.test(record.sessionId) ||
      typeof record.sessionKey !== 'string' ||
      typeof record.cwd !== 'string' ||
      !['fresh', 'uncertain', 'ready'].includes(String(record.state))
    ) {
      throw new Error(
        'Invalid persisted DSH session binding; repair the owned reference before resuming'
      );
    }
    return record as StoredBinding;
  }

  private write(scope: string, record: StoredBinding): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${scope}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.path(scope));
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private path(scope: string): string {
    return join(this.directory, `${scope}.json`);
  }
}

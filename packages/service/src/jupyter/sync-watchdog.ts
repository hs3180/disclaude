import { createHash } from 'node:crypto';
import { textFilePath, type DatalayerJupyterClient } from '@disclaude/core/jupyter';

/**
 * Room-versus-disk comparison shared by the notebook_sync_check tool and the
 * periodic sync watchdog. The room is opened per call and closed after use;
 * nothing is cached. Without forceFlush it never writes: a diverged result
 * reports both hashes and how to reconcile.
 */
export async function checkTextFileSync(
  client: DatalayerJupyterClient,
  roomPath: string,
  options: { forceFlush?: boolean; signal?: AbortSignal } = {}
): Promise<Record<string, unknown>> {
  // Validate before any remote call so traversal rejection stays offline.
  const encoded = textFilePath(roomPath);
  const room = await client.openTextDocument(roomPath);
  try {
    options.signal?.throwIfAborted();
    await room.flush();
    const roomSource = room.source();
    const roomSha = hash(roomSource);
    const roomBytes = Buffer.byteLength(roomSource, 'utf8');
    const read = () =>
      client.json(`api/contents/${encoded}?content=1`) as Promise<Record<string, unknown>>;
    const disk = await read();
    if (disk.type !== 'file') {
      throw new Error('Sync check target is not a Contents file');
    }
    if (disk.format === 'base64') {
      return { status: 'unsupported-binary', path: roomPath };
    }
    if (typeof disk.content !== 'string') {
      throw new Error('Disk content could not be read as text');
    }
    const diskSha = hash(disk.content);
    const diskBytes = Buffer.byteLength(disk.content, 'utf8');
    if (roomSha === diskSha) {
      return { status: 'in-sync', path: roomPath, sha: roomSha, roomBytes, diskBytes };
    }
    if (!options.forceFlush) {
      return {
        status: 'diverged',
        path: roomPath,
        roomSha,
        diskSha,
        roomBytes,
        diskBytes,
        warning:
          'The disk bytes are what the kernel and terminal execute, not the editor room. ' +
          'Idle rooms are destroyed after 60s with a final flush; re-check after that window, ' +
          'or explicitly pass forceFlush:true to write the room snapshot to disk through the contents API.',
      };
    }
    options.signal?.throwIfAborted();
    await client.json(`api/contents/${encoded}`, 'PUT', {
      type: 'file',
      format: 'text',
      content: roomSource,
    });
    const verified = await read();
    if (verified.type !== 'file' || typeof verified.content !== 'string') {
      throw new Error('Flushed disk content could not be verified');
    }
    const flushedSha = hash(verified.content);
    const flushedBytes = Buffer.byteLength(verified.content, 'utf8');
    if (flushedSha === roomSha) {
      return {
        status: 'flushed',
        path: roomPath,
        sha: roomSha,
        roomBytes,
        diskBytes: flushedBytes,
      };
    }
    return {
      status: 'diverged',
      path: roomPath,
      roomSha,
      diskSha: flushedSha,
      roomBytes,
      diskBytes: flushedBytes,
      warning:
        'verification-failed: the contents API still reports different bytes after the forced flush; inspect the server-side save pipeline before retrying',
    };
  } finally {
    room.close();
  }
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const TEXT_EXTENSIONS = new Set([
  '.py',
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.cfg',
  '.ini',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.sh',
  '.sql',
  '.r',
  '.jl',
]);

/**
 * Bounded recursive listing of editable text files under one content root.
 * Notebooks are skipped (they save through the notebook room pipeline, not the
 * text-file fork this watchdog guards) and so are binary or extensionless
 * files, which the room/disk comparison cannot represent as text.
 */
export async function listTextFiles(
  client: DatalayerJupyterClient,
  options: { maxFiles?: number; maxDepth?: number } = {}
): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 200;
  const maxDepth = options.maxDepth ?? 6;
  const files: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (files.length >= maxFiles || depth > maxDepth) {
      return;
    }
    const encoded = directory
      .split('/')
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join('/');
    const listing = (await client.json(`api/contents/${encoded}?content=1`)) as {
      content?: Array<{ path?: string; type?: string; name?: string }>;
    };
    if (!Array.isArray(listing.content)) {
      throw new Error('Sync watch directory listing is not a Contents directory');
    }
    for (const entry of listing.content) {
      if (files.length >= maxFiles) {
        return;
      }
      if (typeof entry.path !== 'string' || typeof entry.type !== 'string') {
        throw new Error('Sync watch directory entry is malformed');
      }
      if (entry.type === 'directory') {
        await walk(entry.path, depth + 1);
      } else if (
        entry.type === 'file' &&
        TEXT_EXTENSIONS.has(entry.path.slice(entry.path.lastIndexOf('.')).toLowerCase())
      ) {
        files.push(entry.path);
      }
    }
  };
  await walk('', 1);
  return files;
}

export interface SyncWatchdogEvent {
  at: string;
  sweep: number;
  checked: number;
  diverged: Array<Record<string, unknown>>;
  flushed: Array<Record<string, unknown>>;
  errors: Array<{ path: string; message: string }>;
}

export interface SyncWatchdogOptions {
  connect<T>(operation: (client: DatalayerJupyterClient) => Promise<T>): Promise<T>;
  /** Sweep cadence; default 60s, mirroring the room cleanup delay window. */
  intervalMs?: number;
  /**
   * Warn-only by default: a diverged file is reported, never written, because
   * a legitimately disk-ahead file (kernel or script output) must not be
   * clobbered with stale room bytes. Opting in flushes the room snapshot to
   * disk only for files whose room and disk hashes differ.
   */
  autoFlush?: boolean;
  maxFiles?: number;
  maxDepth?: number;
  signal?: AbortSignal;
  onEvent?: (event: SyncWatchdogEvent) => void;
}

/**
 * Periodic room-versus-disk sweep over one project's text files. Web Lab
 * sessions keep RTC rooms alive indefinitely, so the 60s room-destruction
 * final flush never fires while they stay connected; this sweep surfaces
 * (and, when autoFlush is enabled, repairs) room/disk forks for those users
 * without waiting for an agent-invoked one-shot check.
 */
export async function sweepTextFileSync(options: SyncWatchdogOptions): Promise<SyncWatchdogEvent> {
  const event: SyncWatchdogEvent = {
    at: new Date().toISOString(),
    sweep: 0,
    checked: 0,
    diverged: [],
    flushed: [],
    errors: [],
  };
  await options.connect(async (client) => {
    const paths = await listTextFiles(client, {
      maxFiles: options.maxFiles,
      maxDepth: options.maxDepth,
    });
    for (const path of paths) {
      options.signal?.throwIfAborted();
      try {
        const result = await checkTextFileSync(client, path, {
          forceFlush: options.autoFlush,
          signal: options.signal,
        });
        event.checked += 1;
        const { status } = result;
        if (status === 'flushed') {
          event.flushed.push(result);
        } else if (status === 'diverged') {
          event.diverged.push(result);
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw error;
        }
        event.errors.push({
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });
  return event;
}

/** Runs sweepTextFileSync on a timer until the signal aborts. */
export async function runSyncWatchdog(options: SyncWatchdogOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 60_000;
  for (let sweep = 1; ; sweep += 1) {
    options.signal?.throwIfAborted();
    const event = await sweepTextFileSync(options);
    event.sweep = sweep;
    options.onEvent?.(event);
    if (options.signal?.aborted) {
      return;
    }
    // An abort during the sleep interval ends the watch gracefully; only an
    // abort inside an in-flight sweep propagates as an error.
    const ended = await abortableDelay(intervalMs, options.signal).then(
      () => false,
      () => true
    );
    if (ended) {
      return;
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Sync watch aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

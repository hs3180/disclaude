/**
 * Ambient module declaration for pino-roll.
 *
 * pino-roll v4 ships no TypeScript types. We consume only its default export —
 * an async builder that returns a rotating SonicBoom destination, used as a
 * `pino()` destination when `logging.rotate` / LOG_ROTATE is enabled (#4777).
 *
 * Issue #3416 removed app-level rotation; we restored it here (opt-in) because
 * Docker deployments have no system logrotate and the single log file grew
 * unbounded (49GB). Rotation remains OFF by default so short-lived CLI entries
 * (push-cli, channel ops) keep the synchronous `pino.destination()` fast path
 * (see logger.ts setupSyncFilePassthrough / "sonic boom is not ready yet").
 */
declare module 'pino-roll' {
  interface PinoRollLimit {
    /** Number of rotated files kept, in addition to the current file. */
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  interface PinoRollOptions {
    /** Absolute or relative path to the base log file. */
    file: string | (() => string);
    /** Max single-file size before rotating; 'k'|'m'|'g' units, or MB number. */
    size?: string | number;
    /** Rotate on a schedule: 'daily' | 'hourly' | milliseconds. */
    frequency?: string | number;
    extension?: string;
    /**
     * Maintain a `current.log` symlink (in the same dir) pointing at the live
     * file. Required for us: pino-roll always writes `<file>.<n>`, never the
     * bare `file` path, so watchers of a fixed path need this symlink.
     */
    symlink?: boolean;
    /** Oldest-file cleanup policy. */
    limit?: PinoRollLimit;
    dateFormat?: string;
    /** Create missing parent dirs. */
    mkdir?: boolean;
  }

  /** Async builder: resolves to a rotating SonicBoom destination. */
  const build: (options: PinoRollOptions) => Promise<unknown>;
  export default build;
}
/** The minimum read-only shape a persistent goal adapter supplies. */
export interface GoalLoopSnapshot { id: string; revision: number; status: string }
export interface GoalLoopPort<T extends GoalLoopSnapshot> {
  read: (id: string) => Promise<T | undefined>;
  /** Own admission and await actual turn settlement, not just queue acceptance.
   * Reconcile prior execution and validate current authority/revision/status
   * before dispatch. Persist assessment/progress before resolving. An unknown
   * or failed execution is never retried by this driver.
   */
  runTurn: (snapshot: Readonly<T>, signal: AbortSignal) => Promise<void>;
}
export type GoalLoopOutcome =
  | { reason: 'inactive'; status: string }
  | { reason: 'missing' }
  | { reason: 'stopped'; error?: unknown }
  | { reason: 'failed'; error: unknown };
export interface GoalLoopHandle {
  completion: Promise<GoalLoopOutcome>;
  /** Requests cancellation; ownership remains held until actual settlement. */
  stop: () => void;
}

/**
 * One sequential driver per explicitly started goal in its owning service.
 * Persistence, user authorization/controls and native execution are adapters;
 * this does not activate goals or restore them automatically after restart.
 */
export class GoalLoop<T extends GoalLoopSnapshot> {
  private readonly runs = new Map<string, GoalLoopHandle>();
  constructor(private readonly port: GoalLoopPort<T>) {}

  start(id: string): GoalLoopHandle {
    if (!id.trim() || id.length > 512) { throw new Error('Invalid goal ID'); }
    const existing = this.runs.get(id);
    if (existing) { return existing; }
    const controller = new AbortController();
    let settle!: (outcome: GoalLoopOutcome) => void;
    const handle: GoalLoopHandle = { completion: new Promise(resolve => { settle = resolve; }), stop: () => controller.abort() };
    this.runs.set(id, handle);
    void this.advance(id, controller.signal).then(outcome => {
      if (this.runs.get(id) === handle) { this.runs.delete(id); }
      settle(outcome);
    });
    return handle;
  }

  private async advance(id: string, signal: AbortSignal): Promise<GoalLoopOutcome> {
    try {
      while (!signal.aborted) {
        const snapshot = await this.port.read(id);
        if (signal.aborted) { return { reason: 'stopped' }; }
        if (!snapshot) { return { reason: 'missing' }; }
        if (snapshot.id !== id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || typeof snapshot.status !== 'string') {
          throw new Error('Invalid goal snapshot');
        }
        if (snapshot.status !== 'active') { return { reason: 'inactive', status: snapshot.status }; }
        await this.port.runTurn(structuredClone(snapshot), signal);
        // Yield to user input/cancellation even when a local turn settles
        // synchronously. Scheduling fairness is not a polling interval.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      return { reason: 'stopped' };
    } catch (error) {
      return signal.aborted ? { reason: 'stopped', error } : { reason: 'failed', error };
    }
  }
}

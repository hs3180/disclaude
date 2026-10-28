type Status = 1 | 2;
interface PeerState {
  peer: string;
  owners: Set<symbol>;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
}

/** One serialized indicator per account/peer; leases represent work and actual delivery. */
export class WeChatTypingController {
  private readonly peers = new Map<string, PeerState>();
  private closed = false;
  constructor(private readonly send: (peer: string, status: Status) => Promise<boolean>,
    private readonly report?: (peer: string, event: string, owners: number) => void) {}

  begin(peer: string): () => void {
    if (this.closed) { return () => {}; }
    let state = this.peers.get(peer);
    if (!state) { state = { peer, owners: new Set(), failures: 0 }; this.peers.set(peer, state); }
    const entry = state; const owner = Symbol(); const idle = entry.owners.size === 0;
    entry.owners.add(owner); this.event(entry, 'acquired');
    if (idle) { clearTimeout(entry.timer); entry.timer = undefined; void this.pump(entry); }
    return () => {
      if (!entry.owners.delete(owner)) { return; }
      this.event(entry, 'released');
      if (!entry.owners.size) {
        clearTimeout(entry.timer); entry.timer = undefined;
        void this.pump(entry);
      }
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.peers.values()];
    for (const entry of entries) {
      clearTimeout(entry.timer); entry.timer = undefined; entry.owners.clear();
    }
    await Promise.all(entries.map(entry => this.pump(entry)));
  }

  private event(entry: PeerState, event: string): void {
    try { this.report?.(entry.peer, event, entry.owners.size); } catch { /* Indicator diagnostics never affect tasks. */ }
  }

  private pump(entry: PeerState): Promise<void> {
    if (entry.running) { return entry.running; }
    entry.running = (async () => {
      for (;;) {
        const active = !this.closed && entry.owners.size > 0;
        let sent = false;
        // Keep the bounded HTTP owner until settlement, then serialize cancel.
        // Cancelling a response already arriving can leave transport callbacks racing teardown.
        try { sent = await this.send(entry.peer, active ? 1 : 2); } catch { /* Non-fatal, bounded retry below. */ }
        this.event(entry, active ? (sent ? 'refreshed' : 'refresh-unavailable') : 'cancelled');
        const stillActive = !this.closed && entry.owners.size > 0;
        // A late cancellation cannot close newer work; reassert the latest desired state.
        if (active !== stillActive) { continue; }
        if (!stillActive) {
          if (this.peers.get(entry.peer) === entry) { this.peers.delete(entry.peer); }
          return;
        }
        entry.failures = sent ? 0 : Math.min(entry.failures + 1, 3);
        entry.timer = setTimeout(() => { entry.timer = undefined; void this.pump(entry); }, Math.min(5_000 * 2 ** entry.failures, 30_000));
        entry.timer.unref?.();
        return;
      }
    })().finally(() => { entry.running = undefined; });
    return entry.running;
  }
}

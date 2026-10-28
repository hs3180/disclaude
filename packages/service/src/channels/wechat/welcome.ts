export const WECHAT_WELCOME_TEXT = '👋 我是 Disclaude。把问题、任务或相关文件发给我，并说明你希望得到的结果。需要用法说明，直接说「怎么用」。';
interface WelcomeReceipt { phase: 'attempted' | 'accepted'; startedAt: string; acceptedAt?: string; messageId?: string }
export interface WeChatWelcomeState { version: 1; botId: string; peers: Record<string, WelcomeReceipt> }
export function emptyWelcomeState(botId: string): WeChatWelcomeState { return { version: 1, botId, peers: {} }; }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
export function validWelcomeState(value: unknown): value is WeChatWelcomeState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
  const state = value as WeChatWelcomeState;
  return Object.keys(state).every(key => ['version', 'botId', 'peers'].includes(key)) && state.version === 1 && text(state.botId)
    && !!state.peers && typeof state.peers === 'object' && !Array.isArray(state.peers) && Object.keys(state.peers).length <= 10_000
    && Object.entries(state.peers).every(([peer, record]) => text(peer) && !!record && typeof record === 'object' && !Array.isArray(record)
      && Object.keys(record).every(key => ['phase', 'startedAt', 'acceptedAt', 'messageId'].includes(key))
      && ['attempted', 'accepted'].includes(record.phase) && text(record.startedAt) && Number.isFinite(Date.parse(record.startedAt))
      && (record.phase === 'accepted' ? record.acceptedAt !== undefined : record.acceptedAt === undefined && record.messageId === undefined)
      && (record.acceptedAt === undefined || (text(record.acceptedAt) && Number.isFinite(Date.parse(record.acceptedAt))))
      && (record.messageId === undefined || text(record.messageId)));
}

/** One owning account listener. Persist intent before sending; uncertain delivery is never blindly repeated. */
export class WeChatWelcome {
  private state: WeChatWelcomeState;
  private readonly jobs = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(state: WeChatWelcomeState, private readonly save: (state: WeChatWelcomeState) => Promise<void>,
    private readonly context: (peer: string) => string | undefined,
    private readonly send: (peer: string, context: string) => Promise<string | undefined>,
    private readonly report?: (peer: string, event: string) => void) {
    if (!validWelcomeState(state)) { throw new Error('Invalid WeChat welcome state'); }
    this.state = structuredClone(state);
  }

  request(peer: string): void {
    if (this.closed || !text(peer) || !this.context(peer) || this.jobs.has(peer) || Object.hasOwn(this.state.peers, peer)) { return; }
    const job = this.run(peer).catch(() => this.event(peer, 'state-unavailable')).finally(() => {
      if (this.jobs.get(peer) === job) { this.jobs.delete(peer); }
    });
    this.jobs.set(peer, job);
  }
  async close(): Promise<void> { this.closed = true; await this.idle(); }
  async idle(): Promise<void> { await Promise.all([...this.jobs.values()]); }
  private event(peer: string, event: string): void { try { this.report?.(peer, event); } catch { /* Never fail the first user task. */ } }

  private update(peer: string, record?: WelcomeReceipt): Promise<void> {
    const operation = this.writes.then(async () => {
      const next = structuredClone(this.state);
      if (record) {
        if (!Object.hasOwn(next.peers, peer) && Object.keys(next.peers).length >= 10_000) { throw new Error('Welcome state full'); }
        next.peers = { ...next.peers, [peer]: record };
      } else { delete next.peers[peer]; }
      await this.save(structuredClone(next)); this.state = next;
    });
    this.writes = operation.catch(() => {}); return operation;
  }

  private async run(peer: string): Promise<void> {
    const attempt: WelcomeReceipt = { phase: 'attempted', startedAt: new Date().toISOString() };
    await this.update(peer, attempt);
    const context = this.context(peer);
    if (!context || this.closed) { await this.update(peer); return; }
    this.event(peer, 'attempting');
    let messageId: string | undefined;
    try { messageId = await this.send(peer, context); }
    catch { this.event(peer, 'delivery-unconfirmed'); return; }
    try {
      await this.update(peer, { ...attempt, phase: 'accepted', acceptedAt: new Date().toISOString(), ...(messageId ? { messageId } : {}) });
      this.event(peer, 'accepted');
    } catch {
      // API acceptance and local checkpoint failure are separate facts.
      this.event(peer, 'accepted-checkpoint-failed');
    }
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeChatTypingController } from './typing-controller.js';

afterEach(() => vi.useRealTimers());
const tick = () => vi.advanceTimersByTimeAsync(0);
describe('account/peer typing leases (#5471)', () => {
  it('refreshes quiet work for multiple intervals, releasing only when all work/delivery owners finish', async () => {
    vi.useFakeTimers(); const send = vi.fn().mockResolvedValue(true);
    const controller = new WeChatTypingController(send);
    const work = controller.begin('peer'); const delivery = controller.begin('peer'); await tick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send.mock.calls.map(call => call[1])).toEqual([1, 1, 1, 1]);
    work(); await vi.advanceTimersByTimeAsync(5_000);
    expect(send.mock.calls.every(call => call[1] === 1)).toBe(true);
    delivery(); await tick(); expect(send.mock.calls.at(-1)?.[1]).toBe(2);
    const count = send.mock.calls.length; await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(count); await controller.close();
  });
  it('never overlaps requests and reasserts new work after a late cancellation', async () => {
    vi.useFakeTimers(); let finishCancel!: (sent: boolean) => void;
    let inFlight = 0; let peak = 0;
    const send = vi.fn(async (_peer: string, status: number) => {
      inFlight++; peak = Math.max(peak, inFlight);
      if (status === 2) { await new Promise<boolean>(resolve => { finishCancel = resolve; }); }
      inFlight--; return true;
    });
    const controller = new WeChatTypingController(send);
    const old = controller.begin('peer'); await tick(); old(); await tick();
    const latest = controller.begin('peer'); expect(send.mock.calls.map(call => call[1])).toEqual([1, 2]);
    finishCancel(true); await tick();
    expect(send.mock.calls.map(call => call[1])).toEqual([1, 2, 1]); expect(peak).toBe(1);
    old(); await tick(); expect(send).toHaveBeenCalledTimes(3);
    latest(); await tick(); const closing = controller.close(); finishCancel(true); await closing;
  });
  it('does not start a second request when a heartbeat is still pending', async () => {
    vi.useFakeTimers(); let finish!: (sent: boolean) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; })).mockResolvedValue(true);
    const controller = new WeChatTypingController(send); const release = controller.begin('peer');
    await vi.advanceTimersByTimeAsync(30_000); expect(send).toHaveBeenCalledTimes(1);
    release(); expect(send.mock.calls[0][2].aborted).toBe(true);
    finish(true); await tick(); expect(send.mock.calls.map(call => call[1])).toEqual([1, 2]);
    await controller.close();
  });
  it('backs off unavailable/missing-ticket pulses without affecting work or leaking raw errors', async () => {
    vi.useFakeTimers(); const send = vi.fn().mockRejectedValue(new Error('private-ticket-context'));
    const events = vi.fn(); const controller = new WeChatTypingController(send, events);
    const release = controller.begin('peer'); await tick();
    await vi.advanceTimersByTimeAsync(9_999); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20_000); expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000); expect(send).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(events.mock.calls)).not.toContain('private-ticket-context');
    release(); await controller.close(); expect(send.mock.calls.at(-1)?.[1]).toBe(2);
  });
  it('isolates peers and the same peer on two different accounts', async () => {
    vi.useFakeTimers(); const accountA = vi.fn().mockResolvedValue(true); const accountB = vi.fn().mockResolvedValue(true);
    const a = new WeChatTypingController(accountA); const b = new WeChatTypingController(accountB);
    const aOne = a.begin('one'); const aTwo = a.begin('two'); const bOne = b.begin('one'); await tick();
    aOne(); await tick(); await vi.advanceTimersByTimeAsync(5_000);
    expect(accountA.mock.calls.filter(call => call[0] === 'one').map(call => call[1])).toEqual([1, 2]);
    expect(accountA.mock.calls.filter(call => call[0] === 'two').map(call => call[1])).toEqual([1, 1]);
    expect(accountB.mock.calls.map(call => call[1])).toEqual([1, 1]);
    aTwo(); bOne(); await Promise.all([a.close(), b.close()]);
  });
  it('aborts pending refresh, best-effort cancels once on close, and cannot be restarted by old leases', async () => {
    vi.useFakeTimers(); const send = vi.fn((_peer: string, status: number, signal: AbortSignal) => status === 1
      ? new Promise<boolean>(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })) : Promise.resolve(true));
    const controller = new WeChatTypingController(send); const release = controller.begin('peer');
    await controller.close(); release(); controller.begin('peer')();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send.mock.calls.map(call => call[1])).toEqual([1, 2]);
  });
});

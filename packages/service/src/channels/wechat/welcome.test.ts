import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyWelcomeState, validWelcomeState, WeChatWelcome } from './welcome.js';
import { WeChatStateStore } from './state-store.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'disclaude-welcome-')); roots.push(root);
  const store = new WeChatStateStore(root); const send = vi.fn().mockResolvedValue('accepted-id');
  const context = vi.fn().mockReturnValue('private-context'); const events = vi.fn();
  const create = async () => new WeChatWelcome(await store.loadWelcome('bot-A'), state => store.saveWelcome(state), context, send, events);
  return { root, store, send, context, events, create };
}

describe('private per-account/peer welcome attempts (#5469)', () => {
  it('persists intent before a single send and never repeats accepted welcome after restart', async () => {
    const f = await fixture(); let finish!: (id: string) => void; let started!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    f.send.mockImplementation(() => { started(); return new Promise<string>(resolve => { finish = resolve; }); });
    const first = await f.create(); first.request('one'); first.request('one'); await sending;
    expect((await f.store.loadWelcome('bot-A')).peers.one.phase).toBe('attempted');
    finish('real-ack'); await first.idle();
    const saved = await f.store.loadWelcome('bot-A'); expect(saved.peers.one).toMatchObject({ phase: 'accepted', messageId: 'real-ack' });
    const restarted = await f.create(); restarted.request('one'); await restarted.idle();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await stat(join(f.root, 'welcome.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(f.root)).mode & 0o777).toBe(0o700);
    await first.close(); await restarted.close();
  });
  it('waits for legal context and reads the latest context immediately before sending', async () => {
    const f = await fixture(); f.context.mockReturnValue(undefined);
    const welcome = await f.create(); welcome.request('one'); await welcome.idle(); expect(f.send).not.toHaveBeenCalled();
    f.context.mockReturnValue('context-A'); welcome.request('one'); f.context.mockReturnValue('context-B');
    await welcome.idle(); expect(f.send).toHaveBeenCalledWith('one', 'context-B');
    await welcome.close();
  });
  it('does not send if the initial durable write fails, and a later input may safely retry', async () => {
    const f = await fixture(); const save = vi.fn().mockRejectedValueOnce(new Error('ENOSPC')).mockImplementation(state => f.store.saveWelcome(state));
    const welcome = new WeChatWelcome(emptyWelcomeState('bot-A'), save, f.context, f.send, f.events);
    welcome.request('one'); await welcome.idle(); expect(f.send).not.toHaveBeenCalled();
    welcome.request('one'); await welcome.idle(); expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveBeenCalledWith('one', 'state-unavailable'); await welcome.close();
  });
  it('retains an uncertain network attempt across restart rather than duplicating the message', async () => {
    const f = await fixture(); f.send.mockRejectedValue(new Error('private-token-context'));
    const first = await f.create(); first.request('one'); await first.idle();
    expect((await f.store.loadWelcome('bot-A')).peers.one.phase).toBe('attempted');
    const restarted = await f.create(); restarted.request('one'); await restarted.idle();
    expect(f.send).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.events.mock.calls)).not.toContain('private-token-context');
    await first.close(); await restarted.close();
  });
  it('keeps API acceptance distinct from a failed receipt checkpoint', async () => {
    const f = await fixture(); let writes = 0;
    const welcome = new WeChatWelcome(emptyWelcomeState('bot-A'), async state => {
      if (++writes === 2) { throw new Error('fixture'); } await f.store.saveWelcome(state);
    }, f.context, f.send, f.events);
    welcome.request('one'); await welcome.idle();
    expect(f.events).toHaveBeenCalledWith('one', 'accepted-checkpoint-failed');
    const restarted = await f.create(); restarted.request('one'); await restarted.idle(); expect(f.send).toHaveBeenCalledTimes(1);
    await welcome.close(); await restarted.close();
  });
  it('serializes peer checkpoints without losing either receipt and isolates another bot', async () => {
    const f = await fixture(); const welcome = await f.create(); welcome.request('one'); welcome.request('two'); await welcome.idle();
    const state = await f.store.loadWelcome('bot-A'); expect(Object.keys(state.peers).sort()).toEqual(['one', 'two']);
    expect(Object.values(state.peers).every(record => record.phase === 'accepted')).toBe(true);
    expect((await f.store.loadWelcome('bot-B')).peers).toEqual({}); await welcome.close();
  });
  it('retains the bounded in-flight send owner through close and preserves an unconfirmed outcome', async () => {
    const f = await fixture(); let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
    let finish!: () => void;
    f.send.mockImplementation(() => { started(); return new Promise((_resolve, reject) => { finish = () => reject(new Error('unknown')); }); });
    const welcome = await f.create(); welcome.request('one'); await pending;
    let closed = false; const closing = welcome.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false); finish(); await closing;
    welcome.request('two'); await welcome.idle(); expect(f.send).toHaveBeenCalledTimes(1);
    expect((await f.store.loadWelcome('bot-A')).peers.one.phase).toBe('attempted');
  });
  it('fails closed on corrupt state and never rewrites unrelated cursor/session data', async () => {
    const f = await fixture(); const session = { botId: 'bot-A', cursor: 'keep-cursor', seenMessageIds: ['keep-id'], contexts: { one: 'keep-context' } };
    await f.store.saveSession(session); const welcome = await f.create(); welcome.request('one'); await welcome.idle();
    expect(await f.store.loadSession('bot-A')).toEqual(session);
    const file = join(f.root, 'welcome.json'); await writeFile(file, 'private-corrupt');
    await expect(f.store.loadWelcome('bot-A')).rejects.toThrow('Cannot read WeChat welcome.json');
    expect(await readFile(file, 'utf8')).toBe('private-corrupt');
    expect(validWelcomeState({ version: 1, botId: 'bot-A', peers: { one: { phase: 'accepted', startedAt: new Date().toISOString() } } })).toBe(false);
    await welcome.close();
  });
});

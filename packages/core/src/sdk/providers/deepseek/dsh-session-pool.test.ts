import { describe, expect, it, vi } from 'vitest';
import { DshStdioTransport } from './dsh-transport.js';
import { DshSessionPool } from './dsh-session-pool.js';

describe('DshSessionPool (Issue #4742)', () => {
  it('reuses a transport for one chat but isolates different chats', () => {
    const transports: DshStdioTransport[] = [];
    const pool = new DshSessionPool({
      createTransport: (options) => {
        const transport = new DshStdioTransport(options);
        transports.push(transport);
        return transport;
      },
    });

    const first = pool.getOrCreate('chat-a');
    expect(pool.getOrCreate('chat-a')).toBe(first);
    const second = pool.getOrCreate('chat-b');

    expect(second).not.toBe(first);
    expect(transports).toHaveLength(2);
    expect(pool.size).toBe(2);
    pool.close();
  });

  it('closes and removes one chat on release', () => {
    const close = vi.spyOn(DshStdioTransport.prototype, 'close');
    const pool = new DshSessionPool();
    pool.getOrCreate('chat-a');

    expect(pool.release('chat-a')).toBe(true);
    expect(pool.release('chat-a')).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    expect(pool.size).toBe(0);

    close.mockRestore();
  });

  it('closes all sessions and rejects new sessions after pool close', () => {
    const close = vi.spyOn(DshStdioTransport.prototype, 'close');
    const pool = new DshSessionPool();
    pool.getOrCreate('chat-a');
    pool.getOrCreate('chat-b');

    pool.close();
    pool.close();

    expect(close).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(0);
    expect(() => pool.getOrCreate('chat-c')).toThrow('dsh session pool is closed');

    close.mockRestore();
  });
});

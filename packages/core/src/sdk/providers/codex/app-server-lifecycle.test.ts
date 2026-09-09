import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAppServerLifecycle } from './app-server-lifecycle.js';

const dirs: string[] = [];
function fixture(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-app-lifecycle-'));
  dirs.push(dir);
  const binary = join(dir, 'codex');
  writeFileSync(binary, `#!/bin/sh\n${body}`);
  chmodSync(binary, 0o755);
  return binary;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CodexAppServerLifecycle', () => {
  it('owns thread/turn identity and sends real steer + interrupt preconditions', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; printf '%s' "$thread" > "$(dirname "$0")/thread"; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; printf '%s' "$start" > "$(dirname "$0")/start"; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read steer; printf '%s' "$steer" > "$(dirname "$0")/steer"; echo '{"id":4,"result":{"turnId":"turn-1"}}'
read interrupt; printf '%s' "$interrupt" > "$(dirname "$0")/interrupt"; echo '{"id":5,"result":{}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}'
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await expect(lifecycle.ensureThread('chat-1', { cwd: '/tmp/project' }))
        .resolves.toBe('thread-1');
      await expect(lifecycle.startTurn('chat-1', 'first')).resolves.toBe('turn-1');
      await expect(lifecycle.steer('chat-1', 'correction')).resolves.toBe('turn-1');
      await lifecycle.interrupt('chat-1');
      await expect.poll(() => lifecycle.snapshot('chat-1')?.state).toBe('idle');

      const dir = dirname(binary);
      expect(JSON.parse(readFileSync(join(dir, 'thread'), 'utf8')).params)
        .toMatchObject({ cwd: '/tmp/project', approvalPolicy: 'never', sandbox: 'read-only' });
      expect(JSON.parse(readFileSync(join(dir, 'steer'), 'utf8')).params)
        .toEqual({ threadId: 'thread-1', expectedTurnId: 'turn-1', input: [{ type: 'text', text: 'correction' }] });
      expect(JSON.parse(readFileSync(join(dir, 'interrupt'), 'utf8')).params)
        .toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    } finally {
      await lifecycle.close();
    }
  });

  it('marks a turn uncertain after disconnect and refuses automatic replay', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start
exit 7
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    await lifecycle.ensureThread('chat-1');
    await expect(lifecycle.startTurn('chat-1', 'possibly committed')).rejects.toThrow(/exited/);
    expect(lifecycle.snapshot('chat-1')?.state).toBe('uncertain');
    await expect(lifecycle.startTurn('chat-1', 'must not replay')).rejects.toThrow(/unknown commit/);
  });

  it('reconciles turn/completed that arrives before the turn/start response', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-early"}}}'
echo '{"id":3,"result":{"turn":{"id":"turn-early"}}}'
while :; do sleep 1; done
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1');
      await lifecycle.startTurn('chat-1', 'fast');
      expect(lifecycle.snapshot('chat-1')).toMatchObject({ state: 'idle' });
      expect(lifecycle.snapshot('chat-1')?.activeTurnId).toBeUndefined();
    } finally {
      await lifecycle.close();
    }
  });

  it('single-flights concurrent initialize and thread creation', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-one"}}}'
while :; do sleep 1; done
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await expect(Promise.all([
        lifecycle.ensureThread('chat-1'),
        lifecycle.ensureThread('chat-1'),
      ])).resolves.toEqual(['thread-one', 'thread-one']);
    } finally {
      await lifecycle.close();
    }
  });

  it('rejects steer and interrupt without a confirmed active turn', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
while :; do sleep 1; done
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1');
      await expect(lifecycle.steer('chat-1', 'nope')).rejects.toThrow(/no steerable active turn/);
      await expect(lifecycle.interrupt('chat-1')).rejects.toThrow(/no steerable active turn/);
    } finally {
      await lifecycle.close();
    }
  });
});

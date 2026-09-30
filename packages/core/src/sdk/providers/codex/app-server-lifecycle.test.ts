import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInputRequest } from '../../user-input.js';
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
  it('checks the selected model catalog and forwards a supported reasoning effort', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read catalog; echo '{"id":3,"result":{"data":[{"id":"gpt-5.6-luna","model":"gpt-5.6-luna","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}]}}'
read start; printf '%s' "$start" > "$(dirname "$0")/start"; echo '{"id":4,"result":{"turn":{"id":"turn-1"}}}'
while :; do sleep 1; done
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1', { model: 'gpt-5.6-luna' });
      await expect(lifecycle.startTurn('chat-1', 'reason deeply', {
        model: 'gpt-5.6-luna', reasoningEffort: 'high',
      })).resolves.toBe('turn-1');
      expect(JSON.parse(readFileSync(join(dirname(binary), 'start'), 'utf8')).params)
        .toMatchObject({ model: 'gpt-5.6-luna', effort: 'high' });
    } finally { await lifecycle.close(); }
  });

  it('rejects an effort absent from the selected model catalog before starting a turn', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read catalog; echo '{"id":3,"result":{"data":[{"id":"gpt-5.6-mini","model":"gpt-5.6-mini","isDefault":true,"supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"high"}]}]}}'
read unexpected; echo '{"id":4,"result":{"turn":{"id":"must-not-start"}}}'
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1', { model: 'gpt-5.6-mini' });
      await expect(lifecycle.startTurn('chat-1', 'unsupported', {
        model: 'gpt-5.6-mini', reasoningEffort: 'ultra',
      })).rejects.toThrow('does not support reasoning effort "ultra"; supported values: low, high');
      expect(lifecycle.snapshot('chat-1')?.state).toBe('idle');
    } finally { await lifecycle.close(); }
  });

  it('reports an unavailable model catalog without leaking transport details', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read catalog; echo '{"id":3,"error":{"code":-32601,"message":"not authorized: bearer secret"}}'
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1', { model: 'gpt-5.6-luna' });
      await expect(lifecycle.startTurn('chat-1', 'verify effort', {
        model: 'gpt-5.6-luna', reasoningEffort: 'high',
      })).rejects.toThrow(
        'Cannot verify Codex reasoning effort "high": the app-server model catalog is unavailable. ' +
        'Update the Codex CLI or unset agent.codex.reasoningEffort.'
      );
      expect(lifecycle.snapshot('chat-1')?.state).toBe('idle');
    } finally { await lifecycle.close(); }
  });

  it('routes async questions to the host and steers only their existing turn', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"id":"question","type":"agentMessage","text":"Choose","questions":[{"title":"Choose","options":["Alpha","Beta"]}]}}}'
IFS= read -r steer; printf '%s' "$steer" > "$(dirname "$0")/steer"; echo '{"id":4,"result":{"turnId":"turn-1"}}'
read hold
`);
    const onUserInput = vi.fn<(request: AgentInputRequest) => Promise<void>>().mockResolvedValue();
    const onNotification = vi.fn();
    const lifecycle = new CodexAppServerLifecycle({ binary, onUserInput, onNotification });
    try {
      await lifecycle.ensureThread('chat-1'); await lifecycle.startTurn('chat-1', 'ask');
      await vi.waitFor(() => expect(onUserInput).toHaveBeenCalledTimes(1));
      const [[request]] = onUserInput.mock.calls;
      expect(request.kind).toBe('async-message');
      expect(onNotification).toHaveBeenCalledWith('item/completed', expect.objectContaining({ agentInputHandled: true }));
      await request.respond({ 'question-1': { answers: ['Beta'] } });
      const message = JSON.parse(readFileSync(join(dirname(binary), 'steer'), 'utf8'));
      expect(message.method).toBe('turn/steer');
      expect(message.params).toMatchObject({ threadId: 'thread-1', expectedTurnId: 'turn-1' });
      expect(message.params.input[0].text).toContain('Beta');
      expect(lifecycle.snapshot('chat-1')?.activeTurnId).toBe('turn-1');
    } finally { await lifecycle.close(); }
  });
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
      await Promise.all([lifecycle.interrupt('chat-1'), lifecycle.interrupt('chat-1')]);
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

  it('fails closed when interrupt is acknowledged without terminal completion', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
read interrupt; echo '{"id":4,"result":{}}'
/bin/sleep 2
`);
    const lifecycle = new CodexAppServerLifecycle({ binary, requestTimeoutMs: 1000 });
    try {
      await lifecycle.ensureThread('chat-1');
      await lifecycle.startTurn('chat-1', 'work');
      await expect(lifecycle.interrupt('chat-1')).rejects.toThrow('completion timed out');
      expect(lifecycle.snapshot('chat-1')?.state).toBe('uncertain');
      await expect(lifecycle.startTurn('chat-1', 'follow up')).rejects.toThrow('unknown commit');
    } finally {await lifecycle.close();}
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
      await expect(lifecycle.steer('chat-1', 'nope')).rejects.toMatchObject({
        name: 'CodexNoActiveTurnError',
        code: 'CODEX_NO_ACTIVE_TURN',
        operation: 'steer',
        sessionState: 'idle',
        threadId: 'thread-1',
        activeTurnId: undefined,
        message: expect.stringContaining('state=idle, threadId=thread-1, activeTurnId=none'),
      });
      await expect(lifecycle.interrupt('chat-1')).rejects.toMatchObject({
        name: 'CodexNoActiveTurnError',
        code: 'CODEX_NO_ACTIVE_TURN',
        operation: 'interrupt',
        message: expect.stringContaining('No control request was sent.'),
      });
    } finally {
      await lifecycle.close();
    }
  });

  it('reports a late control after turn completion as an actionable no-active-turn result', async () => {
    const binary = fixture(`
read initialize; echo '{"id":1,"result":{}}'
read initialized
read thread; echo '{"id":2,"result":{"thread":{"id":"thread-1"}}}'
read start; echo '{"id":3,"result":{"turn":{"id":"turn-1"}}}'
echo '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1"}}}'
while :; do sleep 1; done
`);
    const lifecycle = new CodexAppServerLifecycle({ binary });
    try {
      await lifecycle.ensureThread('chat-1');
      await lifecycle.startTurn('chat-1', 'work');
      await vi.waitFor(() => expect(lifecycle.snapshot('chat-1')?.state).toBe('idle'));

      await expect(lifecycle.steer('chat-1', 'late correction')).rejects.toMatchObject({
        name: 'CodexNoActiveTurnError',
        code: 'CODEX_NO_ACTIVE_TURN',
        operation: 'steer',
        message: expect.stringContaining('The previous turn is complete; send a new message'),
      });
      await expect(lifecycle.interrupt('chat-1')).rejects.toMatchObject({
        name: 'CodexNoActiveTurnError',
        code: 'CODEX_NO_ACTIVE_TURN',
        operation: 'interrupt',
      });
    } finally {
      await lifecycle.close();
    }
  });
});

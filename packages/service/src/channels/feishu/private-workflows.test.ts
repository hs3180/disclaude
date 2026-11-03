import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuPrivateWorkflows, isPrivateWorkflowRequest } from './private-workflows.js';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'private-workflow-'));
  dirs.push(dir);
  const output = join(dir, 'consumed.json');
  const send = vi.fn((_message: Record<string, unknown>) => Promise.resolve('card'));
  const update = vi.fn(() => Promise.resolve());
  const workflows = new FeishuPrivateWorkflows(send, update);
  const request = {
    actorId: 'actor',
    chatId: 'chat',
    sourceMessageId: 'source',
    workflow: {
      title: 'Task chosen workflow',
      description: 'An agent-defined use',
      command: process.execPath,
      args: [
        '-e',
        "let v='';process.stdin.on('data',c=>v+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],JSON.stringify({v,context:JSON.parse(process.env.DISCLAUDE_PRIVATE_CONTEXT)})))",
        output,
      ],
      env: {},
    },
  };
  const callback = () => {
    const card = send.mock.calls.find(([message]) => message.type === 'card')![0].card as any;
    return {
      operator: { open_id: 'actor' },
      context: { open_chat_id: 'chat', open_message_id: 'card' },
      action: {
        value: card.body.elements[1].elements[1].behaviors[0].value,
        form_value: { credential: 'synthetic-private-value' },
      },
    };
  };
  return { workflows, request, callback, send, update, output };
}

describe('agent-defined private workflows', () => {
  it('freezes the task-selected workflow, enforces actor binding and consumes once without reflection', async () => {
    const s = setup();
    try {
      await s.workflows.request(s.request);
      const callback = s.callback();
      s.request.workflow.args.splice(0); // Subsequent caller mutation cannot replace the consumer.
      expect(await s.workflows.submit({ ...callback, operator: { open_id: 'other' } })).toBe(true);
      expect(existsSync(s.output)).toBe(false);
      expect(await s.workflows.submit(callback)).toBe(true);
      expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({
        v: 'synthetic-private-value',
        context: { actor: 'actor', chat: 'chat', source: 'source' },
      });
      // #5489: a replayed submission of a consumed one-shot is handled — the
      // card re-asserts its real terminal status instead of reading expired.
      expect(await s.workflows.submit(callback)).toBe(true);
      expect(s.update).toHaveBeenLastCalledWith('card', expect.objectContaining({
        body: { elements: [{ tag: 'markdown', content: '本次鉴权操作已完成。' }] },
      }));
      expect(JSON.stringify(s.send.mock.calls)).not.toContain('synthetic-private-value');
      expect(JSON.stringify(s.send.mock.calls)).not.toContain(s.output);
    } finally {
      s.workflows.revoke();
    }
  });

  it('ignores typing callbacks without consuming the live form (#5489)', async () => {
    const s = setup();
    try {
      await s.workflows.request(s.request);
      const callback = s.callback();
      const typing = { ...callback, action: { tag: 'input' } };
      expect(await s.workflows.submit(typing)).toBe(false);
      expect(s.update).not.toHaveBeenCalled();
      expect(s.send).toHaveBeenCalledTimes(1);
      expect(existsSync(s.output)).toBe(false);
      expect(await s.workflows.submit(callback)).toBe(true);
      expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({ v: 'synthetic-private-value' });
    } finally {
      s.workflows.revoke();
    }
  });

  it('isolates tasks and revokes reissued, expired and shutdown workflows', async () => {
    const s = setup();
    vi.useFakeTimers();
    try {
      await s.workflows.request(s.request);
      const first = s.callback();
      await s.workflows.request({ ...s.request, actorId: 'second' });
      expect(await s.workflows.submit({ ...first, operator: { open_id: 'second' } })).toBe(true);
      expect(existsSync(s.output)).toBe(false);
      await s.workflows.request(s.request);
      expect(await s.workflows.submit(first)).toBe(false);
      const latest = s.send.mock.calls.filter(([m]) => m.type === 'card').at(-1)![0].card as any;
      const current = {
        ...first,
        action: { ...first.action, value: latest.body.elements[1].elements[1].behaviors[0].value },
      };
      await vi.advanceTimersByTimeAsync(300_001);
      expect(await s.workflows.submit(current)).toBe(false);
      await s.workflows.request(s.request);
      s.workflows.revoke();
      expect(existsSync(s.output)).toBe(false);
    } finally {
      s.workflows.revoke();
    }
  });

  it('drops undelivered workflows and validates the definition before sending', async () => {
    const s = setup();
    s.send.mockRejectedValueOnce(new Error('private consumer detail'));
    await expect(s.workflows.request(s.request)).rejects.toThrow(
      'Private workflow card was not delivered'
    );
    expect(
      isPrivateWorkflowRequest({ ...s.request, workflow: { ...s.request.workflow, args: [7] } })
    ).toBe(false);
    expect(
      isPrivateWorkflowRequest({ ...s.request, workflow: { ...s.request.workflow, timeoutMs: -1 } })
    ).toBe(false);
    s.workflows.revoke();
  });

  it('resumes the waiting session after a consumed submission without another user message (#5411)', async () => {
    const s = setup();
    const notified: Array<{ chatId: string; message: string }> = [];
    s.workflows.setNotifier((chatId, message) => {
      notified.push({ chatId, message });
      return Promise.resolve();
    });
    try {
      await s.workflows.request(s.request);
      // A mismatched actor is not a consumption and must not wake the session.
      expect(await s.workflows.submit({ ...s.callback(), operator: { open_id: 'other' } })).toBe(true);
      expect(notified).toEqual([]);
      expect(await s.workflows.submit(s.callback())).toBe(true);
      expect(notified).toHaveLength(1);
      expect(notified[0].chatId).toBe('chat');
      expect(notified[0].message).toMatch(/succeeded/);
      // The resume signal carries ids/outcome only — never the private value.
      expect(JSON.stringify(notified)).not.toContain('synthetic-private-value');
      expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({ v: 'synthetic-private-value' });
    } finally {
      s.workflows.revoke();
    }
  });

  it('notifies a distinguishable failure outcome and never the private value (#5411)', async () => {
    const s = setup();
    // The consumer exits nonzero: a real failure path with a distinct outcome.
    s.request.workflow.args = ['-e', 'process.stdin.on("data",()=>{process.exit(3)})'];
    const notified: string[] = [];
    s.workflows.setNotifier((_chatId, message) => {
      notified.push(message);
      return Promise.resolve();
    });
    try {
      await s.workflows.request(s.request);
      expect(await s.workflows.submit(s.callback())).toBe(true);
      expect(notified).toHaveLength(1);
      expect(notified[0]).toMatch(/failed/);
      expect(notified[0]).not.toMatch(/succeeded/);
      expect(notified.join()).not.toContain('synthetic-private-value');
    } finally {
      s.workflows.revoke();
    }
  });

  it('keeps the success terminal status when the follow-up text delivery fails (#5411)', async () => {
    const s = setup();
    try {
      await s.workflows.request(s.request);
      // Next send() is the post-consumption status text; make it fail after
      // the card was already repainted to its success terminal status.
      s.send.mockRejectedValueOnce(new Error('text delivery failed'));
      expect(await s.workflows.submit(s.callback())).toBe(true);
      expect(JSON.parse(readFileSync(s.output, 'utf8'))).toMatchObject({ v: 'synthetic-private-value' });
      // The one-shot still finalized, so a replay re-asserts success — not expired.
      expect(await s.workflows.submit(s.callback())).toBe(true);
      expect(s.update).toHaveBeenLastCalledWith('card', expect.objectContaining({
        body: { elements: [{ tag: 'markdown', content: '本次鉴权操作已完成。' }] },
      }));
    } finally {
      s.workflows.revoke();
    }
  });
});

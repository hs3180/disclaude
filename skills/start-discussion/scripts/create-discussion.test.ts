import { describe, expect, it, vi } from 'vitest';
import { createDiscussion, migrationCard, positioningPost } from './create-discussion.mjs';

const input = {
  topic: '发布策略',
  senderOpenId: 'ou_trigger',
  sourceMessageId: 'om_source',
  participants: ['ou_other', 'ou_trigger'],
  idempotencyKey: 'discussion-123',
};
const replies = [
  { data: { chat_id: 'oc_new' } },
  { data: { message_id: 'om_first' } },
  { data: { pin: { message_id: 'om_first' } } },
  { data: { message_id: 'om_migration' } },
];

function mockChain() {
  const run = vi.fn();
  for (const response of replies) run.mockResolvedValueOnce({ stdout: JSON.stringify(response) });
  return run;
}

describe('atomic discussion handoff', () => {
  it('assigns ownership, pins the first positioning post, then replies in the source thread', async () => {
    const run = mockChain();
    await expect(createDiscussion(input, run)).resolves.toEqual({
      chatId: 'oc_new',
      ownerOpenId: 'ou_trigger',
      firstPostMessageId: 'om_first',
      pinned: true,
      migrationMessageId: 'om_migration',
    });
    expect(run).toHaveBeenCalledTimes(4);
    const calls = run.mock.calls.map(([, args]) => args);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['--owner', 'ou_trigger', '--users', 'ou_trigger,ou_other'])
    );
    expect(calls[1].slice(0, 4)).toEqual(['im', '+messages-send', '--chat-id', 'oc_new']);
    const firstPost = calls[1][calls[1].indexOf('--text') + 1];
    expect(firstPost).toContain('本群管什么');
    expect(firstPost).toContain('原群/原 thread 保留什么');
    expect(firstPost).toContain('执行流水去处');
    expect(firstPost).toContain('台账规则');
    expect(calls[2]).toEqual(['im', 'pins', 'create', '--data', '{"message_id":"om_first"}']);
    expect(calls[3]).toEqual(
      expect.arrayContaining(['+messages-reply', '--message-id', 'om_source', '--reply-in-thread'])
    );
    const card = calls[3][calls[3].indexOf('--text') + 1];
    expect(card).toContain('已创建讨论群「发布策略」');
    expect(card).toContain('本 thread 不再推送本话题执行流水');
    for (const [binary, , options] of run.mock.calls) {
      expect(binary).toBe('lark-cli');
      expect(options).not.toHaveProperty('shell');
    }
  });

  it.each([
    ['chat_create', 0],
    ['positioning_post', 1],
    ['pin_positioning_post', 2],
    ['source_migration_card', 3],
  ])('stops the chain and identifies a failed %s stage', async (stage, index) => {
    const run = mockChain();
    run.mockReset();
    for (let i = 0; i < index; i++)
      run.mockResolvedValueOnce({ stdout: JSON.stringify(replies[i]) });
    run.mockRejectedValueOnce(new Error('mock unavailable'));
    await expect(createDiscussion(input, run)).rejects.toThrow(`${stage}: mock unavailable`);
    expect(run).toHaveBeenCalledTimes(index + 1);
  });

  it('does not execute lark-cli for an absent triggering user or source thread', async () => {
    const run = vi.fn();
    await expect(createDiscussion({ ...input, senderOpenId: undefined }, run)).rejects.toThrow(
      'invalid_sender_open_id'
    );
    await expect(createDiscussion({ ...input, sourceMessageId: undefined }, run)).rejects.toThrow(
      'invalid_source_message_id'
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps literal Unicode and shell metacharacters in both templates', () => {
    const hostile = {
      ...input,
      topic: '发布 `x` $(touch nope)\n第二阶段',
      ledgerRule: '保留 $HOME；不执行命令。',
    };
    expect(positioningPost(hostile)).toContain(hostile.topic);
    expect(positioningPost(hostile)).toContain(hostile.ledgerRule);
    expect(migrationCard({ ...hostile, chatId: 'oc_new', ownerOpenId: 'ou_trigger' })).toContain(
      hostile.topic
    );
  });

  it('aborts before any lark-cli call when the runtime preflight rejects the declaration (#4913)', async () => {
    const run = mockChain();
    const previousBase = process.env.DISCLAUDE_API_BASE_URL;
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:9';
    try {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ ok: false, message: 'unknown harness: grok' }),
      });
      await expect(
        createDiscussion({ ...input, runtime: { harness: 'grok', model: 'x' }, fetchImpl }, run)
      ).rejects.toThrow('runtime_rejected:unknown harness: grok');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (previousBase === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; }
      else { process.env.DISCLAUDE_API_BASE_URL = previousBase; }
    }
  });

  it('adds the runtime line to the pinned positioning post and echoes the profile (#4913)', async () => {
    const run = mockChain();
    const previousBase = process.env.DISCLAUDE_API_BASE_URL;
    process.env.DISCLAUDE_API_BASE_URL = 'http://127.0.0.1:9';
    try {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          profile: { name: 'researcher', agentBackend: 'codex', model: 'gpt-5.2-codex', thinking: 'high' },
        }),
      });
      await expect(
        createDiscussion({ ...input, runtime: { preset: 'researcher' }, fetchImpl }, run)
      ).resolves.toMatchObject({
        chatId: 'oc_new',
        runtime: { name: 'researcher', agentBackend: 'codex', model: 'gpt-5.2-codex', thinking: 'high' },
      });
      const firstPost = run.mock.calls[1][1][run.mock.calls[1][1].indexOf('--text') + 1];
      expect(firstPost).toContain('researcher');
      expect(firstPost).toContain('codex / gpt-5.2-codex / thinking: high');
      expect(firstPost).toContain('/agent use');
    } finally {
      if (previousBase === undefined) { delete process.env.DISCLAUDE_API_BASE_URL; }
      else { process.env.DISCLAUDE_API_BASE_URL = previousBase; }
    }
  });

  it('omits the runtime line when no runtime was declared (legacy shape unchanged)', () => {
    expect(positioningPost(input)).not.toContain('运行时');
  });
});

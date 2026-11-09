#!/usr/bin/env node
/** Create a discussion group and complete its user-visible handoff in one ordered chain. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);

function requiredId(value, prefix, name) {
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error(`invalid_${name}`);
  return value;
}

function dataOf(response) {
  return response?.data && typeof response.data === 'object' ? response.data : response;
}

const RUNTIME_KEYS = new Set(['preset', 'harness', 'model', 'thinking']);

/**
 * Issue #4913: validate a declared runtime profile against the service's
 * configured enabled catalog BEFORE the group is created, so an incompatible
 * or unsupported declaration aborts with an actionable error and never
 * produces a half-configured active group. The declaration never carries
 * credentials or endpoints — a named preset or an explicit
 * harness/model/thinking triple only.
 */
async function preflightRuntime(runtime, fetchImpl = fetch) {
  if (runtime === undefined || runtime === null) { return undefined; }
  if (typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new Error('runtime_must_be_object');
  }
  const unknown = Object.keys(runtime).filter((key) => !RUNTIME_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`runtime_rejects_fields:${unknown.join(',')}`);
  }
  for (const [key, value] of Object.entries(runtime)) {
    if (typeof value !== 'string' || !value.trim()) { throw new Error(`runtime_${key}_must_be_nonempty_string`); }
  }
  const baseUrl = process.env.DISCLAUDE_API_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl) {
    throw new Error('runtime_preflight_requires_DISCLAUDE_API_BASE_URL');
  }
  const headers = { 'Content-Type': 'application/json' };
  const token = process.env.DISCLAUDE_API_TOKEN?.trim();
  if (token) { headers.Authorization = `Bearer ${token}`; }
  const response = await fetchImpl(`${baseUrl}/api/agent-runtime`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ runtime }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true) {
    throw new Error(`runtime_rejected:${body.message ?? response.status}`);
  }
  return body.profile;
}

export function positioningPost({
  topic,
  ledgerRule = '本群台账只记录本群决策与交付，原群历史不重复搬运。',
}) {
  return `【群定位声明】讨论：${topic}\n- 本群管什么：只讨论「${topic}」及该话题的决策与交付。\n- 原群/原 thread 保留什么：原有其他话题与历史上下文，不再承接本话题讨论。\n- 执行流水去处：本话题的进度、执行流水与交付只发到本群。\n- 台账规则：${ledgerRule}`;
}

export function migrationCard({ topic, chatId, ownerOpenId }) {
  return `【话题迁移】已创建讨论群「${topic}」（${chatId}）。\n- 新群管什么：本话题讨论、执行流水与交付。\n- 原群/原 thread 保留什么：其他话题与既有历史；本 thread 不再推送本话题执行流水。\n- 群主：已移交给触发用户 ${ownerOpenId}，新群首帖定位声明已置顶。`;
}

export async function createDiscussion(input, run = execute) {
  const topic = typeof input?.topic === 'string' ? input.topic.trim() : '';
  if (!topic) throw new Error('invalid_topic');
  const ownerOpenId = requiredId(input.senderOpenId, 'ou_', 'sender_open_id');
  const sourceMessageId = requiredId(input.sourceMessageId, 'om_', 'source_message_id');
  const participants = input.participants ?? [];
  if (!Array.isArray(participants)) throw new Error('invalid_participants');
  const users = [
    ...new Set([
      ownerOpenId,
      ...participants.map((id) => requiredId(id, 'ou_', 'participant_open_id')),
    ]),
  ];
  const idempotencyKey = input.idempotencyKey;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(idempotencyKey))
  ) {
    throw new Error('invalid_idempotency_key');
  }
  // Issue #4913: validate the runtime declaration before any Feishu API call.
  const profile = await preflightRuntime(input.runtime, input.fetchImpl);

  const invoke = async (args, stage) => {
    try {
      const { stdout } = await run('lark-cli', args, { timeout: 60000, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } catch (error) {
      error.message = `${stage}: ${error.message}`;
      throw error;
    }
  };
  const sendOptions = idempotencyKey ? ['--idempotency-key', idempotencyKey] : [];

  const created = dataOf(
    await invoke(
      [
        'im',
        '+chat-create',
        '--name',
        `讨论: ${topic}`,
        '--description',
        `Agent 发起的讨论: ${topic}`,
        '--users',
        users.join(','),
        '--owner',
        ownerOpenId,
      ],
      'chat_create'
    )
  );
  const chatId = requiredId(created?.chat_id ?? created?.chatId, 'oc_', 'new_chat_id');

  const firstPost = positioningPost(input);
  const sent = dataOf(
    await invoke(
      ['im', '+messages-send', '--chat-id', chatId, '--text', firstPost, ...sendOptions],
      'positioning_post'
    )
  );
  const firstPostMessageId = requiredId(
    sent?.message_id ?? sent?.messageId,
    'om_',
    'positioning_message_id'
  );

  await invoke(
    ['im', 'pins', 'create', '--data', JSON.stringify({ message_id: firstPostMessageId })],
    'pin_positioning_post'
  );

  const migrated = dataOf(
    await invoke(
      [
        'im',
        '+messages-reply',
        '--message-id',
        sourceMessageId,
        '--reply-in-thread',
        '--text',
        migrationCard({ topic, chatId, ownerOpenId }),
        ...sendOptions,
      ],
      'source_migration_card'
    )
  );
  const migrationMessageId = requiredId(
    migrated?.message_id ?? migrated?.messageId,
    'om_',
    'migration_message_id'
  );
  return {
    chatId,
    ownerOpenId,
    firstPostMessageId,
    pinned: true,
    migrationMessageId,
    ...(profile ? { runtime: profile } : {}),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await createDiscussion(JSON.parse(readFileSync(0, 'utf8')))));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

/**
 * Feishu side discussions (支线讨论) — delivery arm of `/discuss` (Issue #5412).
 *
 * The core command parses input and picks a venue; this component executes it
 * on Feishu and owns the persisted source link:
 *
 * - `message-thread` — `im.message.reply` with `reply_in_thread` anchored at
 *   the trigger (or command) message. The thread's root is that anchor, so
 *   follow-up replies key the agent pool on `chatId::anchor` (Issue #4587
 *   part 2): the side discussion gets its own session and the main line is
 *   never paused or interleaved.
 * - `topic-thread` — a new root message in a topic group; a root message
 *   without `parent_id` starts a new native topic there.
 * - `p2p` — DM the requesting user (`receive_id_type: open_id`); the group's
 *   main conversation is a different chat and keeps running.
 *
 * Every venue posts the same positioning text (question + source refs +
 * context boundary + flow-back instruction), so the side agent's thread
 * context carries the origin without any manual copy-paste. `/discuss done`
 * posts the conclusion back into the source venue and marks the record.
 *
 * Group creation is deliberately NOT done here — that stays with the
 * start-discussion skill chain (lark-cli create → pin → migration card →
 * push_to_agent); core degrades `--group` to a delegation bundle instead.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { Client } from '@larksuiteoapi/node-sdk';
import { Config, createLogger, type SideDiscussionSummary } from '@disclaude/core';

const logger = createLogger('SideDiscussions');

const TRIGGER_EXCERPT_MAX = 400;
const TITLE_MAX = 32;

export interface SideDiscussionRecord extends SideDiscussionSummary {
  seq: number;
  question: string;
  /** Source chat (where /discuss was typed). */
  chatId: string;
  /** Chat that carries the venue (differs from chatId only for p2p venues). */
  venueChatId: string;
  /** The replied-to message, when the command was a reply. */
  triggerMessageId?: string;
  /** The /discuss command message itself. */
  sourceMessageId?: string;
  /** Thread root at command time (command typed inside an existing topic). */
  sourceThreadRootId?: string;
  actorId?: string;
  conclusion?: string;
  concludedAt?: string;
}

interface StoreFile {
  seq: number;
  records: SideDiscussionRecord[];
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function textContent(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw) { return undefined; }
  try {
    const parsed = object(JSON.parse(raw));
    const { text } = object(parsed);
    return typeof text === 'string' && text.trim() ? text : undefined;
  } catch {
    return raw.trim() ? raw : undefined;
  }
}

export function sideTitle(question: string): string {
  const compact = question.replace(/\s+/g, ' ').trim();
  return compact.length > TITLE_MAX ? `${compact.slice(0, TITLE_MAX)}…` : compact;
}

/** Positioning post: the side venue's first message and its context boundary. */
export function positioningPost(record: {
  id: string;
  question: string;
  chatId: string;
  triggerMessageId?: string;
  triggerExcerpt?: string;
}): string {
  return [
    `【支线讨论 ${record.id}】${sideTitle(record.question)}`,
    `- 讨论问题：${record.question}`,
    `- 来源：会话 ${record.chatId}；触发消息 ${record.triggerMessageId ?? '（无，取当前对话背景）'}`,
    ...(record.triggerExcerpt
      ? [`  > 触发消息摘录：${record.triggerExcerpt}`]
      : []),
    '- 上下文边界：本支线只讨论上述问题；主线会话不会暂停、也不会自动收到本支线的消息；需要更多背景请回到来源会话查看。',
    `- 回流：得出结论后在本支线发送 \`/discuss done ${record.id} <结论摘要>\`，摘要会回贴到来源会话，主线可继续。`,
  ].join('\n');
}

/** Conclusion post delivered back into the source venue. */
export function conclusionPost(record: SideDiscussionRecord, summary: string): string {
  return [
    `【支线结论 ${record.id}】${sideTitle(record.question)}`,
    summary,
    '— 来自支线讨论的回流摘要；主线任务未受影响，可直接继续。',
  ].join('\n');
}

/**
 * File-backed record store (workspace/side-discussions.json). Follows the
 * BotChatMappingStore pattern: in-memory cache + atomic write. The file is a
 * rebuildable index of active links, not a source of truth for Feishu state.
 */
export class SideDiscussionStore {
  private cache: StoreFile = { seq: 0, records: [] };
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  static defaultFilePath(): string {
    return path.join(Config.getWorkspaceDir(), 'side-discussions.json');
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) { return; }
    this.initPromise = this.initPromise ?? this.init();
    await this.initPromise;
  }

  private async init(): Promise<void> {
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf-8');
      const parsed = object(JSON.parse(content));
      const records = Array.isArray(parsed.records) ? parsed.records : [];
      this.cache = {
        seq: typeof parsed.seq === 'number' && parsed.seq >= 0 ? parsed.seq : records.length,
        records: records.filter((item): item is SideDiscussionRecord => {
          const record = object(item);
          return typeof record.id === 'string' && typeof record.chatId === 'string';
        }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err: error, filePath: this.filePath }, 'side-discussion store unreadable; starting empty');
      }
      this.cache = { seq: 0, records: [] };
    } finally {
      this.initialized = true;
    }
  }

  private async persist(): Promise<boolean> {
    const tmpFile = `${this.filePath}.${Date.now()}.tmp`;
    try {
      await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsPromises.writeFile(tmpFile, `${JSON.stringify(this.cache, null, 2)}\n`, 'utf-8');
      await fsPromises.rename(tmpFile, this.filePath);
      return true;
    } catch (error) {
      try { await fsPromises.unlink(tmpFile); } catch { /* nothing to clean up */ }
      logger.error({ err: error, filePath: this.filePath }, 'side-discussion store persist failed');
      return false;
    }
  }

  async create(draft: Omit<SideDiscussionRecord, 'id' | 'seq' | 'createdAt' | 'status'>):
  Promise<SideDiscussionRecord> {
    await this.ensureInitialized();
    const seq = this.cache.seq + 1;
    const record: SideDiscussionRecord = {
      ...draft,
      id: `side-${seq}`,
      seq,
      createdAt: new Date().toISOString(),
      status: 'open',
    };
    this.cache.seq = seq;
    this.cache.records.push(record);
    await this.persist();
    return record;
  }

  async find(id: string): Promise<SideDiscussionRecord | null> {
    await this.ensureInitialized();
    return this.cache.records.find(record => record.id === id) ?? null;
  }

  /** Records reachable from a chat — as the source or as the venue (p2p). */
  async listForChat(chatId: string): Promise<SideDiscussionRecord[]> {
    await this.ensureInitialized();
    return this.cache.records.filter(record => record.chatId === chatId || record.venueChatId === chatId);
  }

  async save(record: SideDiscussionRecord): Promise<boolean> {
    await this.ensureInitialized();
    const index = this.cache.records.findIndex(item => item.id === record.id);
    if (index === -1) { return false; }
    this.cache.records[index] = record;
    return this.persist();
  }
}

export class FeishuSideDiscussions {
  constructor(
    private readonly client: Client,
    private readonly store: SideDiscussionStore
  ) {}

  private async fetchTriggerExcerpt(messageId: string | undefined): Promise<string | undefined> {
    if (!messageId) { return undefined; }
    try {
      const response = await this.client.im.message.get({ path: { message_id: messageId } });
      if (response.code !== 0) { return undefined; }
      const item = response.data?.items?.find(entry => entry.message_id === messageId);
      const content = textContent(item?.body?.content);
      if (!content) { return undefined; }
      return content.length > TRIGGER_EXCERPT_MAX ? `${content.slice(0, TRIGGER_EXCERPT_MAX)}…` : content;
    } catch {
      // Best-effort context carry: the ID reference stays even without the excerpt.
      return undefined;
    }
  }

  /** Open a side venue per the core routing decision and persist the source link. */
  async open(request: {
    chatId: string;
    question: string;
    venue: 'topic-thread' | 'message-thread' | 'p2p';
    anchorMessageId?: string;
    triggerMessageId?: string;
    commandMessageId?: string;
    threadRootId?: string;
    chatType?: 'p2p' | 'group' | 'topic';
    actorId?: string;
  }): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    try {
      if (request.venue === 'message-thread' && !request.anchorMessageId) {
        return { ok: false, error: '缺少话题锚点消息，无法开原生话题线程' };
      }
      if (request.venue === 'p2p' && !request.actorId) {
        return { ok: false, error: '缺少发起人身份，无法转入私聊（--private 需在聊天中直接发送）' };
      }
      const record = await this.store.create({
        question: request.question,
        title: sideTitle(request.question),
        venue: request.venue,
        chatId: request.chatId,
        venueChatId: request.venue === 'p2p' ? request.actorId as string : request.chatId,
        ...(request.triggerMessageId ? { triggerMessageId: request.triggerMessageId } : {}),
        ...(request.commandMessageId ? { sourceMessageId: request.commandMessageId } : {}),
        ...(request.threadRootId ? { sourceThreadRootId: request.threadRootId } : {}),
        ...(request.actorId ? { actorId: request.actorId } : {}),
      });
      const triggerExcerpt = await this.fetchTriggerExcerpt(request.triggerMessageId);
      const content = JSON.stringify({
        text: positioningPost({ ...record, triggerExcerpt }),
      });

      let anchorMessageId: string | undefined;
      if (request.venue === 'p2p') {
        const result = await this.client.im.message.create({
          params: { receive_id_type: 'open_id' },
          data: { receive_id: request.actorId as string, msg_type: 'text', content },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`私聊首帖未送达（code ${result.code}）`);
        }
      } else if (request.venue === 'topic-thread') {
        const result = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: request.chatId, msg_type: 'text', content },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`新话题首帖未送达（code ${result.code}）`);
        }
        anchorMessageId = result.data.message_id;
      } else {
        const anchor = request.anchorMessageId as string;
        const result = await this.client.im.message.reply({
          path: { message_id: anchor },
          data: { msg_type: 'text', content, reply_in_thread: true },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`话题线程首帖未送达（code ${result.code}）`);
        }
        anchorMessageId = anchor;
      }

      record.anchorMessageId = anchorMessageId;
      await this.store.save(record);
      const venueLabel = request.venue === 'p2p'
        ? '已转入与你的私聊承接'
        : request.venue === 'topic-thread'
          ? `已在话题群开出新话题（根消息 ${anchorMessageId}）`
          : `已以消息 ${anchorMessageId} 为根开出原生话题线程`;
      return {
        ok: true,
        message: `已开支线 ${record.id}：${venueLabel}。在支线内讨论即可，主线不受影响；结论用 \`/discuss done ${record.id} <摘要>\` 回流。`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Post a conclusion summary back to the source venue and close the record. */
  async conclude(request: {
    chatId: string;
    id?: string;
    threadRootId?: string;
    summary: string;
    actorId?: string;
  }): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
    try {
      const record = await this.resolve(request);
      if (!record) {
        const active = (await this.store.listForChat(request.chatId)).filter(item => item.status === 'open');
        const hint = active.length
          ? `本聊天进行中的支线：${active.map(item => item.id).join('、')}。请用 \`/discuss done <id> <摘要>\` 指定。`
          : '本聊天没有可回流的支线记录；/discuss status 可查看全部记录。';
        return { ok: false, error: `未匹配到支线记录。${hint}` };
      }
      if (record.status === 'concluded') {
        return { ok: false, error: `支线 ${record.id} 已于 ${record.concludedAt ?? '此前'} 回流过结论；如需补充请另开支线。` };
      }
      const content = JSON.stringify({ text: conclusionPost(record, request.summary) });
      const parent = record.sourceThreadRootId ?? record.sourceMessageId;
      if (parent) {
        const result = await this.client.im.message.reply({
          path: { message_id: parent },
          data: { msg_type: 'text', content, ...(record.sourceThreadRootId ? { reply_in_thread: true } : {}) },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`结论回贴未送达（code ${result.code}）`);
        }
      } else {
        const result = await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: record.chatId, msg_type: 'text', content },
        });
        if (result.code !== 0 || !result.data?.message_id) {
          throw new Error(`结论回贴未送达（code ${result.code}）`);
        }
      }
      const concluded: SideDiscussionRecord = {
        ...record,
        status: 'concluded',
        conclusion: request.summary,
        concludedAt: new Date().toISOString(),
      };
      await this.store.save(concluded);
      return {
        ok: true,
        message: `支线 ${record.id} 的结论已回贴到来源会话（${record.chatId}），记录已关闭；主线可继续当前任务。`,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async resolve(request: { chatId: string; id?: string; threadRootId?: string }):
  Promise<SideDiscussionRecord | null> {
    if (request.id) { return this.store.find(request.id); }
    if (!request.threadRootId) { return null; }
    const matches = (await this.store.listForChat(request.chatId)).filter(record =>
      record.status === 'open' && record.anchorMessageId === request.threadRootId);
    return matches.length === 1 ? matches[0] : null;
  }

  async list(chatId: string): Promise<SideDiscussionSummary[]> {
    const records = await this.store.listForChat(chatId);
    return records
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .map(({ id, title, venue, anchorMessageId, createdAt, status }) => ({
        ...(anchorMessageId ? { anchorMessageId } : {}),
        id, title, venue, createdAt, status,
      }));
  }
}

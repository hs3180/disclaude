/** Feishu document source and comment synchronization for project Research. */

import { createHash } from 'node:crypto';
import type { Client } from '@larksuiteoapi/node-sdk';
import type { ResearchDocumentSnapshot } from './project.js';

export type DocumentReader = (
  token: string,
  publishedFragments?: readonly string[]
) => Promise<ResearchDocumentSnapshot>;

/** Append one revision-guarded, idempotent Research publication to a docx. */
export type DocumentWriter = (
  token: string,
  expectedRevision: number,
  content: string,
  clientToken: string
) => Promise<{ revision: number }>;

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (): never => {
  throw new Error('关联文档未同步：请检查访问权限、文档大小或并发修改后恢复。已有成果保留。');
};

export function documentToken(url: string): string | undefined {
  if (!url.trim()) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('请填写新版飞书文档的 HTTPS /docx/ 链接。');
  }
  const token = /^\/docx\/([A-Za-z0-9]+)\/?$/u.exec(parsed.pathname)?.[1];
  if (parsed.protocol !== 'https:' || !token || token.length > 100) {
    throw new Error('请填写新版飞书文档的 HTTPS /docx/ 链接；Wiki 和非文本附件暂不支持。');
  }
  return token;
}

/** Read complete document text and all comment replies, then verify revision stability. */
export function createDocumentReader(client: Client): DocumentReader {
  return async (token, publishedFragments = []) => {
    const before = await client.docx.document.get({ path: { document_id: token } });
    const revision = before.data?.document?.revision_id;
    if (before.code !== 0 || !Number.isSafeInteger(revision)) {
      return fail();
    }
    const raw = await client.docx.document.rawContent({ path: { document_id: token } });
    if (
      raw.code !== 0 ||
      typeof raw.data?.content !== 'string' ||
      raw.data.content.length > 256_000
    ) {
      return fail();
    }

    const comments: ResearchDocumentSnapshot['comments'] = [];
    const seenPages = new Set<string>();
    let pageToken: string | undefined;
    do {
      const response = await client.drive.fileComment.list({
        path: { file_token: token },
        params: {
          file_type: 'docx',
          page_size: 50,
          page_token: pageToken,
          user_id_type: 'open_id',
        },
      });
      if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) {
        return fail();
      }
      for (const comment of response.data.items) {
        if (!comment.comment_id) {
          return fail();
        }
        const replies = [...(comment.reply_list?.replies ?? [])];
        let hasMore = comment.has_more;
        let replyToken = comment.page_token;
        const seenReplyPages = new Set<string>();
        while (hasMore) {
          if (!replyToken || seenReplyPages.has(replyToken) || seenReplyPages.size >= 20) {
            return fail();
          }
          seenReplyPages.add(replyToken);
          const page = await client.drive.fileCommentReply.list({
            path: { file_token: token, comment_id: comment.comment_id },
            params: {
              file_type: 'docx',
              page_size: 50,
              page_token: replyToken,
              user_id_type: 'open_id',
            },
          });
          if (page.code !== 0 || !page.data || !Array.isArray(page.data.items)) {
            return fail();
          }
          replies.push(...page.data.items);
          hasMore = page.data.has_more;
          replyToken = page.data.page_token;
        }
        if (!replies.length) {
          return fail();
        }
        for (const reply of replies) {
          if (!reply.reply_id || reply.extra?.image_list?.length) {
            return fail();
          }
          const body = reply.content.elements
            .map((element) => {
              if (element.type === 'text_run') {
                return element.text_run?.text ?? '';
              }
              if (element.type === 'docs_link') {
                return element.docs_link?.url ?? '';
              }
              return element.person?.user_id ?? '';
            })
            .join('');
          const text = `${comment.is_solved ? '已解决评论' : '评论'}${comment.quote ? `（引用：${comment.quote}）` : ''}\n${body}`;
          if (text.length > 3000 || comments.length >= 200) {
            return fail();
          }
          comments.push({ id: `${comment.comment_id}/${reply.reply_id}`, text });
        }
      }
      if (!response.data.has_more) {
        break;
      }
      pageToken = response.data.page_token;
      if (!pageToken || seenPages.has(pageToken) || seenPages.size >= 20) {
        return fail();
      }
      seenPages.add(pageToken);
    } while (true);
    if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
      return fail();
    }

    const after = await client.docx.document.get({ path: { document_id: token } });
    if (after.code !== 0 || after.data?.document?.revision_id !== revision) {
      return fail();
    }
    comments.sort((a, b) => a.id.localeCompare(b.id));
    let body = raw.data.content;
    for (const fragment of publishedFragments) {
      const start = body.indexOf(fragment);
      const end = start + fragment.length;
      if (
        start >= 0 &&
        body.indexOf(fragment, end) < 0 &&
        (start === 0 || body[start - 1] === '\n') &&
        (end === body.length || body[end] === '\n')
      ) {
        body = body.slice(0, start) + body.slice(end + (body[end] === '\n' ? 1 : 0));
      }
    }
    if (body.length > 48_000 || JSON.stringify({ body, comments }).length > 64_000) {
      return fail();
    }
    return {
      token,
      revision: revision as number,
      body,
      rawBody: raw.data.content,
      comments,
      fingerprint: digest({ body, comments }),
      syncedAt: new Date().toISOString(),
    };
  };
}

/**
 * Create the narrow document write capability used by Research.
 *
 * The root document block is also addressed by the document token. The
 * revision precondition makes a concurrent user edit fail closed instead of
 * appending results against a stale snapshot; client_token makes retries safe
 * when Feishu has accepted a request but the service was interrupted before
 * persisting its local publication marker.
 */
export function createDocumentWriter(client: Client): DocumentWriter {
  return async (token, expectedRevision, content, clientToken) => {
    const response = await client.docx.documentBlockChildren.create({
      data: {
        children: [
          {
            block_type: 2,
            text: { elements: [{ text_run: { content } }] },
          },
        ],
      },
      params: {
        document_revision_id: expectedRevision,
        client_token: clientToken,
      },
      path: {
        document_id: token,
        block_id: token,
      },
    });
    const revision = response.data?.document_revision_id;
    if (response.code !== 0 || !Number.isSafeInteger(revision)) {
      throw new Error('关联文档写回失败：文档可能已被修改或当前应用没有编辑权限。');
    }
    return { revision: revision as number };
  };
}

export function changedDocumentFeedback(
  previous: ResearchDocumentSnapshot | undefined,
  next: ResearchDocumentSnapshot
): Array<{ key: string; text: string }> {
  const feedback: Array<{ key: string; text: string }> = [];
  // The first successful read establishes the user's document as baseline
  // material; it is not a user edit that needs a feedback receipt.
  if (!previous) {
    return feedback;
  }
  if (previous?.body !== next.body) {
    feedback.push({
      key: `body:${digest(next.body)}`,
      text: '关联文档正文已更新。请根据最新完整正文核对研究范围、材料和用户修订，并记录意见处理及实际工作变化。',
    });
  }
  for (const comment of next.comments) {
    if (
      previous?.comments.find((candidate) => candidate.id === comment.id)?.text !== comment.text
    ) {
      feedback.push({ key: `comment:${comment.id}:${digest(comment.text)}`, text: comment.text });
    }
  }
  for (const comment of previous?.comments ?? []) {
    if (!next.comments.some((candidate) => candidate.id === comment.id)) {
      feedback.push({
        key: `removed:${comment.id}:${next.fingerprint}`,
        text: `此前评论已删除，请核对其对结论的影响，不自动撤销或重复执行旧意见：\n${comment.text}`,
      });
    }
  }
  return feedback;
}

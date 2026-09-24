#!/usr/bin/env node
// Convert complete, saved CLI responses without changing document/comment bytes.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function requireValue(value, message) { if (!value) throw new Error(message); }
function nonempty(value) { return typeof value === 'string' && value.length > 0; }
function pagesFor(pages, documentId, commentId) {
  requireValue(Array.isArray(pages) && pages.length > 0, 'missing_pages');
  return pages.flatMap((page, index) => {
    const data = page?.data;
    requireValue(page?.ok === true && data?.file_token === documentId, 'invalid_page_document');
    requireValue(data.has_more === (index < pages.length - 1), 'incomplete_or_extra_pages');
    requireValue(Array.isArray(data.items), 'invalid_page_items');
    if (commentId !== undefined) requireValue(data.comment_id === commentId, 'reply_thread_mismatch');
    return data.items;
  });
}

export function feishuSnapshot(input) {
  const document = input?.document?.data?.document;
  requireValue(input?.document?.ok === true && nonempty(document?.document_id) &&
    typeof document.content === 'string' &&
    (Number.isSafeInteger(document.revision_id) || nonempty(document.revision_id)), 'invalid_document_response');
  const documentId = document.document_id;
  const threads = pagesFor(input.commentPages, documentId);
  requireValue(Array.isArray(input.replyPages), 'missing_reply_pages');
  const groups = new Map();
  for (const group of input.replyPages) {
    requireValue(nonempty(group?.commentId) && !groups.has(group.commentId), 'duplicate_or_invalid_reply_group');
    groups.set(group.commentId, group.pages);
  }
  const threadIds = new Set();
  const comments = [];
  for (const thread of threads) {
    requireValue(nonempty(thread.comment_id) && !threadIds.has(thread.comment_id), 'duplicate_or_invalid_thread');
    threadIds.add(thread.comment_id);
    const replies = pagesFor(groups.get(thread.comment_id), documentId, thread.comment_id);
    requireValue(replies.length > 0, 'missing_initial_reply');
    const replyIds = new Set();
    for (const reply of replies) {
      requireValue(nonempty(reply.reply_id) && !replyIds.has(reply.reply_id), 'duplicate_or_invalid_reply');
      replyIds.add(reply.reply_id);
      requireValue(Array.isArray(reply.content?.elements), 'invalid_reply_content');
      const body = reply.content.elements.map(element => {
        // Do not silently drop images/mentions or invent text for unsupported content.
        requireValue(element.type === 'text_run' && typeof element.text_run?.text === 'string', 'unsupported_reply_content');
        return element.text_run.text;
      }).join('');
      comments.push({ id: `${thread.comment_id}:${reply.reply_id}`, body });
    }
  }
  requireValue(groups.size === threadIds.size, 'unexpected_reply_group');
  return { documentId, revision: String(document.revision_id), body: document.content, comments, complete: true };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    console.log(JSON.stringify(feishuSnapshot(input)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

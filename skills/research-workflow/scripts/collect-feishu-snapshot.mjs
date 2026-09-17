#!/usr/bin/env node
/** Live, read-only collection. Timestamp is issued only after all pages validate. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { feishuSnapshot } from './feishu-snapshot.mjs';

const execute = promisify(execFile);
async function runCli(args) {
  const { stdout } = await execute('lark-cli', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function collectFeishuSnapshot(documentId, identity, { run = runCli, now = () => new Date().toISOString() } = {}) {
  if (typeof documentId !== 'string' || !/^[A-Za-z0-9]+$/.test(documentId) || !['user', 'bot'].includes(identity)) {
    throw new Error('document_token_and_explicit_identity_required');
  }
  const startedAt = now();
  const document = await run(['docs', '+fetch', '--doc', documentId, '--doc-format', 'markdown', '--scope', 'full', '--as', identity]);
  if (document?.ok !== true || document?.data?.document?.document_id !== documentId) throw new Error('invalid_document_response');
  const common = ['--token', documentId, '--type', 'docx', '--as', identity, '--page-size', '100'];
  async function pages(command, extra = []) {
    const result = [], seen = new Set();
    let token;
    for (;;) {
      const page = await run(['drive', command, ...common, ...extra, ...(token ? ['--page-token', token] : [])]);
      const data = page?.data;
      if (page?.ok !== true || data?.file_token !== documentId || !Array.isArray(data.items) || typeof data.has_more !== 'boolean') {
        throw new Error('invalid_page_response');
      }
      result.push(page);
      if (!data.has_more) return result;
      token = data.page_token;
      if (typeof token !== 'string' || !token.length || seen.has(token)) throw new Error('invalid_or_repeated_page_token');
      seen.add(token);
    }
  }
  const commentPages = await pages('+list-comments', ['--comment-scope', 'all', '--solved-status', 'all']);
  const replyPages = [], threads = new Set();
  for (const thread of commentPages.flatMap(page => page.data.items)) {
    const id = thread.comment_id;
    if (typeof id !== 'string' || !id.length || threads.has(id)) throw new Error('duplicate_or_invalid_thread');
    threads.add(id);
    replyPages.push({ commentId: id, pages: await pages('+list-replies', ['--comment-id', id]) });
  }
  const responses = { document, commentPages, replyPages };
  const snapshot = feishuSnapshot(responses);
  const completedAt = now();
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt)) || Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('invalid_collection_clock');
  }
  return { ...snapshot, collection: { startedAt, completedAt }, responses };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [documentId, identity, extra] = process.argv.slice(2);
    if (extra) throw new Error('usage: collect-feishu-snapshot.mjs <document-token> <user|bot>');
    console.log(JSON.stringify(await collectFeishuSnapshot(documentId, identity)));
  } catch {
    // Child-process errors can contain full command output. Do not echo document content.
    console.error(JSON.stringify({ ok: false, error: 'snapshot_collection_failed' }));
    process.exitCode = 1;
  }
}

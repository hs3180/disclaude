/**
 * Minimal Feishu document-comment read surface for the research doc monitor
 * (T-089 / #5197).
 *
 * The interface is intentionally the smallest face the monitor needs (list
 * comment threads, paginated). The default adapter shells out to the same
 * `lark-cli drive +list-comments` invocation already exercised by
 * `skills/research-workflow/scripts/collect-feishu-snapshot.mjs` and
 * `packages/service/src/goals/lark-task-board-port.ts`, with the same strict
 * response validation.
 *
 * UNKNOWN (offline, not verifiable here): the real Feishu comment event/
 * subscription API, the exact item field names beyond `comment_id`, and the
 * CLI's error vocabulary for rate limits and permission denials. The
 * normalizer therefore treats every field except `comment_id` as best-effort
 * and keeps `raw` for passthrough; failures are classified conservatively and
 * every classification surfaces in monitor error reports.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DocWatchIdentity } from './doc-watch-registry.js';

const exec = promisify(execFile);

/** A single top-level comment thread on a document, normalized. */
export interface DocCommentThread {
  /** Stable thread identity — the dedup key. Verified shape (skill scripts). */
  commentId: string;
  /** Author open_id/user_id when present (shape unverified). */
  authorId?: string;
  /** Author display name when present (shape unverified). */
  authorName?: string;
  /** First reply's content text when present (may be rich-text JSON string). */
  contentText?: string;
  /** Thread creation time in epoch ms when present. */
  createdAtMs?: number;
  /** Last modification time in epoch ms when present. */
  editedAtMs?: number;
  /** Whole-document comment flag (`is_whole`, per research-workflow protocol). */
  isWhole?: boolean;
  /** Solved state when present. */
  isSolved?: boolean;
  /** Number of replies when derivable. */
  replyCount?: number;
  /** Unmodified source item for auditing/forwarding. */
  raw: unknown;
}

export interface DocCommentPage {
  items: DocCommentThread[];
  hasMore: boolean;
  nextPageToken?: string;
}

export interface DocCommentListRequest {
  docToken: string;
  docType: string;
  identity: DocWatchIdentity;
  pageToken?: string;
  pageSize: number;
}

export type DocCommentSourceErrorKind =
  /** Transient failure (CLI exit, network, rate limit…) — retry with backoff.
   * Rate-limit responses are NOT distinguished yet: the CLI's error shape for
   * Feishu 429/94003 is unknown offline. */
  | 'transient'
  /** Access denied for the identity — needs human/agent attention, not retry. */
  | 'permission'
  /** Response did not match the verified envelope — never silently ignored. */
  | 'invalid-response';

export class DocCommentSourceError extends Error {
  constructor(
    readonly kind: DocCommentSourceErrorKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DocCommentSourceError';
  }
}

/** Comment source — injectable; unit tests use fakes. */
export interface DocCommentSource {
  listComments(request: DocCommentListRequest): Promise<DocCommentPage>;
}

/** Injectable CLI runner (defaults to lark-cli via execFile). */
export type RunLarkCli = (args: string[]) => Promise<{ stdout: string }>;

const PERMISSION_HINT = /permission|forbidden|deny|denied|无权限|没有权限|访问权限/i;

function classifyFailure(error: unknown): DocCommentSourceError {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? String((error as { stderr?: unknown }).stderr ?? '') : '';
  const kind: DocCommentSourceErrorKind = PERMISSION_HINT.test(message) || PERMISSION_HINT.test(stderr)
    ? 'permission'
    : 'transient';
  // Child-process errors can embed CLI output; keep it out of messages that
  // may reach logs — the kind and a short message are enough.
  return new DocCommentSourceError(kind, `lark-cli list-comments failed (${kind})`, undefined);
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) { return value; }
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) { return Number(value); }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) { return value; }
  }
  return undefined;
}

/**
 * Normalize one raw comment item. Only `comment_id` is mandatory (it is the
 * dedup key); every other field is best-effort because the real item shape is
 * unknown offline. Unrecognized shapes still produce a valid thread with
 * `raw` preserved.
 */
export function normalizeDocCommentThread(item: unknown): DocCommentThread {
  if (typeof item !== 'object' || item === null) {
    throw new DocCommentSourceError('invalid-response', 'comment item is not an object');
  }
  const record = item as Record<string, unknown>;
  const commentId = firstString(record.comment_id);
  if (!commentId) {
    throw new DocCommentSourceError('invalid-response', 'comment item missing comment_id');
  }
  const user = record.user_id && typeof record.user_id === 'object'
    ? record.user_id as Record<string, unknown> : undefined;
  const replyList = Array.isArray(record.reply_list) ? record.reply_list as unknown[] : undefined;
  const firstReply = replyList?.find(reply => reply && typeof reply === 'object') as Record<string, unknown> | undefined;
  const replyContent = firstString(firstReply?.content, record.content);
  return {
    commentId,
    authorId: firstString(user?.open_id, user?.user_id, user?.union_id, record.user_id && typeof record.user_id === 'string' ? record.user_id : undefined),
    authorName: firstString(user?.name, firstReply?.user_name, record.user_name),
    contentText: replyContent,
    createdAtMs: toMs(record.created_time ?? record.create_time),
    editedAtMs: toMs(record.modified_time ?? record.updated_time),
    isWhole: record.is_whole === true || record.whole === true ? true
      : record.is_whole === false || record.whole === false ? false : undefined,
    isSolved: typeof record.solved === 'boolean' ? record.solved : undefined,
    replyCount: replyCountOf(record, replyList),
    raw: item,
  };
}

function replyCountOf(record: Record<string, unknown>, replyList: unknown[] | undefined): number | undefined {
  if (typeof record.reply_count === 'number' && Number.isFinite(record.reply_count)) { return record.reply_count; }
  if (replyList) { return replyList.length; }
  return undefined;
}

/** Validate the envelope the skill scripts verified: ok/data.file_token/items/has_more. */
function parseListResponse(parsed: unknown, docToken: string): DocCommentPage {
  if (typeof parsed !== 'object' || parsed === null || (parsed as Record<string, unknown>).ok !== true) {
    throw new DocCommentSourceError('invalid-response', 'list-comments response missing ok:true');
  }
  const { data } = parsed as Record<string, unknown>;
  if (typeof data !== 'object' || data === null) {
    throw new DocCommentSourceError('invalid-response', 'list-comments response missing data');
  }
  const record = data as Record<string, unknown>;
  if (record.file_token !== docToken) {
    throw new DocCommentSourceError('invalid-response', 'list-comments file_token mismatch');
  }
  if (!Array.isArray(record.items) || typeof record.has_more !== 'boolean') {
    throw new DocCommentSourceError('invalid-response', 'list-comments items/has_more invalid');
  }
  const page: DocCommentPage = { items: record.items.map(normalizeDocCommentThread), hasMore: record.has_more };
  const nextToken = firstString(record.page_token);
  if (record.has_more && !nextToken) {
    throw new DocCommentSourceError('invalid-response', 'has_more without page_token');
  }
  if (!record.has_more && nextToken === undefined) { return page; }
  if (nextToken !== undefined) { page.nextPageToken = nextToken; }
  return page;
}

export interface LarkCliDocCommentSourceOptions {
  /** Overrides the process spawn (tests inject a fake here). */
  run?: RunLarkCli;
  /** execFile timeout per call (default 60s). */
  timeoutMs?: number;
}

/**
 * Default `DocCommentSource` backed by `lark-cli drive +list-comments`.
 *
 * `--as <identity>` keeps reads inside the configured identity's permissions
 * (research protocol reads as `user`); `--comment-scope all --solved-status
 * all` matches the skill's collection script so solved threads are still
 * visible as feedback.
 */
export function createLarkCliDocCommentSource(
  options: LarkCliDocCommentSourceOptions = {},
): DocCommentSource {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const run: RunLarkCli = options.run ?? (args => exec('lark-cli', args, {
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  }));
  return {
    listComments: async request => {
      const args = [
        'drive', '+list-comments',
        '--token', request.docToken,
        '--type', request.docType,
        '--comment-scope', 'all',
        '--solved-status', 'all',
        '--as', request.identity,
        '--page-size', String(request.pageSize),
        ...(request.pageToken ? ['--page-token', request.pageToken] : []),
      ];
      const stdout = await run(args).then(
        result => result.stdout,
        error => { throw classifyFailure(error); },
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new DocCommentSourceError('invalid-response', 'list-comments stdout is not JSON');
      }
      return parseListResponse(parsed, request.docToken);
    },
  };
}

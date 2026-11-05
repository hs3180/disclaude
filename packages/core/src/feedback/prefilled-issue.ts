import type { ChatFailureRecord } from './failure-registry.js';
import { sanitizeDiagnosticText } from '../utils/diagnostic-text.js';

export const DEFAULT_ISSUE_REPOSITORY = 'hs3180/disclaude';
export const MAX_PREFILLED_ISSUE_URL_LENGTH = 6000;

/** Keep public drafts bounded and tolerate malformed strings without affecting the original error. */
function safe(value: unknown, fallback: string, limit: number): string {
  const text = Buffer.from(String(value ?? ''), 'utf8').toString('utf8');
  return sanitizeDiagnosticText(text).trim().slice(0, limit) || fallback;
}

/** A deliberately small public draft: no chat/session/message/user IDs or message bodies. */
export function createPrefilledIssueDraft(
  record: ChatFailureRecord,
  version: string,
): { title: string; body: string } {
  const diagnosticId = safe(record.diagnosticId, 'unavailable', 64);
  const failureClass = safe(record.failureClass, 'unknown', 80);
  const detail = safe(record.detail, 'No error detail was captured.', 300);
  const headline = detail.split('\n')[0].slice(0, 80);
  const body = [
    '### Failure summary',
    `- Diagnostic ID: \`${diagnosticId}\``,
    `- Class: ${failureClass}`,
    `- Time (UTC): ${safe(record.timestamp, 'unavailable', 40)}`,
    `- Disclaude version: ${safe(version, 'unavailable', 40)}`,
    `- Backend / provider: ${safe(record.backend ?? record.provider, 'unavailable', 80)}`,
    '',
    '### Sanitized error',
    detail,
    '',
    '### Reproduction clues',
    'Search the service log by diagnostic ID. Missing context is marked unavailable; add observed and expected behavior before submitting if useful.',
    '',
    '> Prefilled by disclaude `/issue`. No chat, session, message or user identifiers are included.',
  ].join('\n');
  return { title: `[feedback] ${failureClass}: ${headline} (diag ${diagnosticId.slice(0, 8)})`.slice(0, 160), body };
}

/** Build a local URL only; this function never calls GitHub or requires credentials. */
export function createPrefilledIssueUrl(
  record: ChatFailureRecord,
  version: string,
  repository = DEFAULT_ISSUE_REPOSITORY,
): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Invalid issue repository');
  }
  const draft = createPrefilledIssueDraft(record, version);
  const query = new URLSearchParams({ title: draft.title, body: draft.body });
  // Parentheses stay literal under form encoding but terminate a Markdown link.
  const url = `https://github.com/${repository}/issues/new?${query.toString()}`
    .replaceAll('(', '%28')
    .replaceAll(')', '%29');
  if (url.length > MAX_PREFILLED_ISSUE_URL_LENGTH) {
    throw new Error('Prefilled issue URL exceeds the copyable length limit');
  }
  return url;
}

/**
 * Minimal GitHub App issue client (Issue #5400, PR A).
 *
 * Authentication follows the GitHub App server flow:
 *   RS256 JWT (app id) → installation access token → REST calls.
 *
 * `ensureIssue` is idempotent per diagnosticId: before creating an issue it
 * searches the repository's OPEN issues for the diagnosticId (which the caller
 * must embed in title/body), and an in-flight lock collapses concurrent
 * submissions of the same diagnosticId — repeated card clicks cannot create
 * duplicate issues. A failed submission releases the lock so an explicit
 * retry is possible; failures are returned, never thrown as success.
 */

import { createSign } from 'node:crypto';

/** Resolved GitHub App target the client submits to. */
export interface GitHubIssueTarget {
  /** `owner/name` repository, e.g. `hs3180/disclaude`. */
  repository: string;
  appId: string;
  installationId: string;
  /** PEM private key of the GitHub App. */
  privateKey: string;
}

/** Issue draft; `diagnosticId` is the idempotency key and MUST appear in the body. */
export interface GitHubIssueDraft {
  diagnosticId: string;
  title: string;
  body: string;
  labels?: string[];
}

export type GitHubIssueResult =
  | { ok: true; status: 'created' | 'existing'; issueUrl: string; issueNumber: number }
  | { ok: false; kind: 'auth' | 'network' | 'other'; error: string };

export interface GitHubIssueClientDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (epoch ms) for JWT/token expiry; defaults to Date.now. */
  now?: () => number;
}

const API_ROOT = 'https://api.github.com';
/** Refresh an installation token this many ms before its stated expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export class GitHubIssueClient {
  private readonly target: GitHubIssueTarget;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private token: { value: string; expiresAtMs: number } | undefined;
  private readonly inFlight = new Map<string, Promise<GitHubIssueResult>>();

  constructor(target: GitHubIssueTarget, deps: GitHubIssueClientDeps = {}) {
    this.target = target;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  /** Create (or find) the issue for `draft`, deduplicated by diagnosticId. */
  ensureIssue(draft: GitHubIssueDraft): Promise<GitHubIssueResult> {
    const pending = this.inFlight.get(draft.diagnosticId);
    if (pending) {
      return pending;
    }
    const attempt = this.attemptEnsureIssue(draft).finally(() => {
      this.inFlight.delete(draft.diagnosticId);
    });
    this.inFlight.set(draft.diagnosticId, attempt);
    return attempt;
  }

  private async attemptEnsureIssue(draft: GitHubIssueDraft): Promise<GitHubIssueResult> {
    if (!draft.body.includes(draft.diagnosticId)) {
      return {
        ok: false,
        kind: 'other',
        error: 'Issue body must embed the diagnostic ID for deduplication',
      };
    }
    try {
      const token = await this.installationToken();
      const search = await this.callGitHub(
        `/search/issues?q=${encodeURIComponent(`repo:${this.target.repository} is:issue is:open ${draft.diagnosticId}`)}`,
        { method: 'GET', token }
      );
      if (!search.ok) {
        return this.failureFromStatus(search.status, 'Searching existing issues failed');
      }
      const found = (await search.json()) as {
        total_count?: number;
        items?: Array<{ number?: number; html_url?: string }>;
      };
      const match = found.items?.find(
        (item) => typeof item.number === 'number' && typeof item.html_url === 'string'
      );
      if (found.total_count && match?.html_url && match.number !== undefined) {
        return {
          ok: true,
          status: 'existing',
          issueUrl: match.html_url,
          issueNumber: match.number,
        };
      }
      const created = await this.callGitHub(`/repos/${this.target.repository}/issues`, {
        method: 'POST',
        token,
        body: JSON.stringify({
          title: draft.title,
          body: draft.body,
          ...(draft.labels?.length ? { labels: draft.labels } : {}),
        }),
      });
      if (!created.ok) {
        return this.failureFromStatus(created.status, 'Creating the issue failed');
      }
      const issue = (await created.json()) as { number?: number; html_url?: string };
      if (typeof issue.number !== 'number' || typeof issue.html_url !== 'string') {
        return {
          ok: false,
          kind: 'other',
          error: 'GitHub returned an issue without a number or URL',
        };
      }
      return { ok: true, status: 'created', issueUrl: issue.html_url, issueNumber: issue.number };
    } catch (error) {
      if (error instanceof AuthError) {
        return { ok: false, kind: 'auth', error: error.message };
      }
      // fetch only rejects on network-level failures (DNS, refused, aborted).
      return {
        ok: false,
        kind: 'network',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Mint (or reuse a cached) installation token via the app JWT. */
  private async installationToken(): Promise<string> {
    if (this.token && this.token.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > this.now()) {
      return this.token.value;
    }
    const response = await this.fetchImpl(
      `${API_ROOT}/app/installations/${this.target.installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.appJwt()}`,
          Accept: 'application/vnd.github+json',
        },
      }
    );
    if (!response.ok) {
      const error = await errorMessage(response);
      throw new AuthError(`GitHub App token request failed (HTTP ${response.status}): ${error}`);
    }
    const data = (await response.json()) as { token?: string; expires_at?: string };
    if (!data.token || !data.expires_at) {
      throw new AuthError('GitHub App token response missing token or expiry');
    }
    this.token = { value: data.token, expiresAtMs: Date.parse(data.expires_at) };
    return data.token;
  }

  /** RS256-signed app JWT valid for 10 minutes (GitHub's maximum). */
  private appJwt(): string {
    const issuedAt = Math.floor(this.now() / 1000) - 60;
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(
      JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: this.target.appId })
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(this.target.privateKey, 'base64url')}`;
  }

  private callGitHub(
    path: string,
    init: { method: string; token: string; body?: string }
  ): Promise<Response> {
    return this.fetchImpl(`${API_ROOT}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${init.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });
  }

  private failureFromStatus(status: number, context: string): GitHubIssueResult {
    const kind = status === 401 || status === 403 || status === 404 ? 'auth' : 'other';
    return { ok: false, kind, error: `${context} (HTTP ${status})` };
  }
}

/** Auth-flow failures surface as `kind: 'auth'`, not as network noise. */
class AuthError extends Error {}

async function errorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { message?: string };
    return data.message ?? 'no message';
  } catch {
    return 'no message';
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

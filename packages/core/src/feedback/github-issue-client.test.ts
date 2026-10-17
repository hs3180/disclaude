import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import nock from 'nock';
import { GitHubIssueClient, type GitHubIssueTarget } from './github-issue-client.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const target: GitHubIssueTarget = {
  repository: 'hs3180/disclaude',
  appId: '3129570',
  installationId: '117680580',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};
const API = 'https://api.github.com';
const DIAGNOSTIC_ID = '33333333-3333-4333-8333-333333333333';
const draft = {
  diagnosticId: DIAGNOSTIC_ID,
  title: `[feedback] provider failure (diag ${DIAGNOSTIC_ID.slice(0, 8)})`,
  body: `diagnostic ID ${DIAGNOSTIC_ID}\nsanitized detail`,
};

/** Intercept the installation-token exchange and capture the app JWT. */
function tokenScope(status = 201, tokenValue = 'ghs_install_token') {
  let jwt = '';
  const scope = nock(API)
    .post('/app/installations/117680580/access_tokens')
    .reply(
      status,
      function (_uri, _body) {
        jwt = (this.req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        return { token: tokenValue, expires_at: new Date(Date.now() + 3600_000).toISOString() };
      },
      { 'content-type': 'application/json' }
    );
  return { scope, jwt: () => jwt };
}

describe('GitHubIssueClient.ensureIssue', () => {
  it('mints a verifiable app JWT, then creates the issue and returns its URL', async () => {
    const { jwt } = tokenScope();
    nock(API)
      .get(
        `/search/issues?q=${encodeURIComponent(`repo:hs3180/disclaude is:issue is:open ${DIAGNOSTIC_ID}`)}`
      )
      .matchHeader('authorization', 'Bearer ghs_install_token')
      .reply(200, { total_count: 0, items: [] });
    nock(API)
      .post(
        '/repos/hs3180/disclaude/issues',
        (body) => body.body.includes(DIAGNOSTIC_ID) && body.title.includes('[feedback]')
      )
      .reply(201, { number: 5400, html_url: 'https://github.com/hs3180/disclaude/issues/5400' });

    const client = new GitHubIssueClient(target);
    const result = await client.ensureIssue(draft);

    expect(result).toEqual({
      ok: true,
      status: 'created',
      issueUrl: 'https://github.com/hs3180/disclaude/issues/5400',
      issueNumber: 5400,
    });
    // The minted JWT must be a valid RS256 signature issued by the app id.
    const [header, payload, signature] = jwt().split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe('3129570');
    expect(claims.exp - claims.iat).toBe(600);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, signature, 'base64url')).toBe(true);
  });

  it('returns the existing open issue instead of creating a duplicate', async () => {
    tokenScope();
    nock(API)
      .get(/\/search\/issues\?/)
      .reply(200, {
        total_count: 1,
        items: [{ number: 5399, html_url: 'https://github.com/hs3180/disclaude/issues/5399' }],
      });
    nock(API)
      .post('/repos/hs3180/disclaude/issues')
      .reply(201, { number: 9999, html_url: 'unused' });

    const client = new GitHubIssueClient(target);
    const result = await client.ensureIssue(draft);
    expect(result).toEqual({
      ok: true,
      status: 'existing',
      issueUrl: 'https://github.com/hs3180/disclaude/issues/5399',
      issueNumber: 5399,
    });
  });

  it('collapses concurrent submissions of one diagnostic ID into a single create', async () => {
    tokenScope();
    let searchHits = 0;
    nock(API)
      .get(/\/search\/issues\?/)
      .reply(200, () => {
        searchHits++;
        return { total_count: 0, items: [] };
      });
    // .once(): a second create attempt would fail the test via nock errors.
    nock(API)
      .post('/repos/hs3180/disclaude/issues')
      .once()
      .reply(201, { number: 1, html_url: 'https://github.com/hs3180/disclaude/issues/1' });

    const client = new GitHubIssueClient(target);
    const [first, second] = await Promise.all([
      client.ensureIssue(draft),
      client.ensureIssue(draft),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, status: 'created' });
    expect(searchHits).toBe(1); // the shared attempt searched once
  });

  it('reports authentication failures without throwing', async () => {
    tokenScope(401, '');
    const client = new GitHubIssueClient(target);
    await expect(client.ensureIssue(draft)).resolves.toMatchObject({ ok: false, kind: 'auth' });
  });

  it('reports network failures and allows an explicit retry afterwards', async () => {
    tokenScope();
    nock(API)
      .get(/\/search\/issues\?/)
      .replyWithError('ECONNRESET');
    const client = new GitHubIssueClient(target);
    await expect(client.ensureIssue(draft)).resolves.toMatchObject({ ok: false, kind: 'network' });

    // The in-flight lock is released; a retry succeeds without a new token.
    nock(API)
      .get(/\/search\/issues\?/)
      .reply(200, { total_count: 0, items: [] });
    nock(API)
      .post('/repos/hs3180/disclaude/issues')
      .reply(201, { number: 2, html_url: 'https://github.com/hs3180/disclaude/issues/2' });
    await expect(client.ensureIssue(draft)).resolves.toMatchObject({ ok: true, status: 'created' });
  });

  it('classifies a failed issue creation and reuses the cached installation token', async () => {
    const { scope: tokenCalls } = tokenScope();
    nock(API)
      .get(/\/search\/issues\?/)
      .twice()
      .reply(200, { total_count: 0, items: [] });
    nock(API).post('/repos/hs3180/disclaude/issues').once().reply(500, { message: 'boom' });
    nock(API)
      .post('/repos/hs3180/disclaude/issues')
      .once()
      .reply(201, { number: 3, html_url: 'https://github.com/hs3180/disclaude/issues/3' });

    const client = new GitHubIssueClient(target);
    await expect(client.ensureIssue(draft)).resolves.toMatchObject({ ok: false, kind: 'other' });
    await expect(client.ensureIssue(draft)).resolves.toMatchObject({ ok: true, status: 'created' });
    expect(tokenCalls.isDone()).toBe(true); // exactly one token mint, then cached
  });

  it('rejects a draft whose body cannot be found by the diagnostic search', async () => {
    const client = new GitHubIssueClient(target);
    await expect(
      client.ensureIssue({ ...draft, body: 'no diagnostic id here' })
    ).resolves.toMatchObject({ ok: false, kind: 'other' });
  });
});

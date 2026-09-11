import { beforeEach, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { PrivateGitHubCheck } from './private-github-check.js';

const token = 'ghs_synthetic123456789';
function setup() {
  let now = 1000;
  const audit = vi.fn();
  const check = new PrivateGitHubCheck('owner/repo', audit, () => now);
  const issued = check.issue('actor', 'chat', 'source');
  check.bindCard(issued.nonce, 'card');
  const input = { actor: 'actor', chat: 'chat', card: 'card', action: issued.value.private_action, source: 'source', nonce: issued.nonce, credential: token };
  return { check, input, audit, expire: () => {now += 300000;} };
}

describe('private GitHub permission check', () => {
  beforeEach(() => {if (!nock.isActive()) {nock.activate();}});
  it('consumes concurrent submissions exactly once and audits only safe metadata', async () => {
    const { check, input, audit } = setup();
    const api = nock('https://api.github.com', { reqheaders: { authorization: `Bearer ${token}` } })
      .get('/repos/owner/repo/secret-scanning/alerts').query({ state: 'open', per_page: 1 }).reply(200, [{ secret: 'never-forward-this' }]);
    const results = await Promise.all([check.submit(input), check.submit(input)]);
    expect(api.isDone()).toBe(true);
    expect(results[0]).toContain('检查成功');
    expect(results[1]).toContain('已使用');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([results, audit.mock.calls])).not.toMatch(/synthetic123456789|never-forward-this/);
    expect(audit.mock.calls[0][0].correlationId).not.toBe(input.nonce);
  });

  it.each(['actor', 'chat', 'card', 'source', 'nonce', 'action'])('rejects a mismatched %s before exchange', async field => {
    const { check, input, audit } = setup();
    expect(await check.submit({ ...input, [field]: 'different' })).toContain('无效');
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects expiry, revocation and reissue', async () => {
    const { check, input, expire } = setup();
    expire();
    expect(await check.submit(input)).toContain('过期');
    const fresh = check.issue('actor', 'chat', 'source');
    check.bindCard(fresh.nonce, 'card');
    check.issue('actor', 'chat', 'source');
    expect(await check.submit({ ...input, nonce: fresh.nonce })).toContain('无效');
    check.revoke();
    expect(await check.submit(input)).toContain('无效');
  });

  it('does not confuse permission denial with no alerts and consumes failures', async () => {
    const { check, input, audit } = setup();
    const api = nock('https://api.github.com').get(/secret-scanning/).reply(403, { secret: token });
    expect(await check.submit(input)).toContain('不代表没有告警');
    expect(api.isDone()).toBe(true);
    expect(await check.submit(input)).toContain('已使用');
    expect(JSON.stringify(audit.mock.calls)).not.toContain(token);
  });
});

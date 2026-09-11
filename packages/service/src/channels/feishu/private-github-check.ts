import { request } from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

const ACTION = 'github-secret-scanning';
const TTL_MS = 5 * 60 * 1000;
interface Binding { actor: string; chat: string; source: string; card?: string; expires: number }
interface Audit { action: string; actor: string; chat: string; outcome: string; timestamp: number; correlationId: string }

/** One action, one fixed GitHub repository, no credential retrieval or storage.
 * The submitted token is used once against GitHub's read-only alerts endpoint.
 * Only the initiating actor can submit; bindings expire after five minutes.
 * Restart/reissue revokes outstanding forms. Original values never leave this
 * handler except in the HTTPS Authorization header, and are never persisted.
 */
export class PrivateGitHubCheck {
  private readonly pending = new Map<string, Binding>();
  constructor(
    private readonly repository: string,
    private readonly audit: (event: Audit) => void,
    private readonly now = Date.now,
  ) {}

  issue(actor: string, chat: string, source: string): { nonce: string; value: Record<string, string> } {
    if (!/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(this.repository) || !actor || !chat || !source) {
      throw new Error('Private GitHub check is not configured');
    }
    for (const [nonce, binding] of this.pending) {
      if (binding.expires <= this.now() || (binding.actor === actor && binding.chat === chat)) {this.pending.delete(nonce);}
    }
    if (this.pending.size >= 500) {throw new Error('Too many pending private checks');}
    const nonce = randomBytes(32).toString('hex');
    this.pending.set(nonce, { actor, chat, source, expires: this.now() + TTL_MS });
    return { nonce, value: { private_action: ACTION, nonce, source } };
  }

  bindCard(nonce: string, card: string): void {
    const binding = this.pending.get(nonce);
    if (binding && !binding.card) {binding.card = card;}
  }

  revoke(): void {this.pending.clear();}

  async submit(input: { actor: string; chat: string; card: string; action: unknown; nonce: unknown; source: unknown; credential: unknown }): Promise<string> {
    const nonce = typeof input.nonce === 'string' ? input.nonce : '';
    const binding = this.pending.get(nonce);
    if (!binding || binding.expires <= this.now() || input.action !== ACTION ||
        binding.actor !== input.actor || binding.chat !== input.chat || binding.card !== input.card || binding.source !== input.source) {
      if (binding && binding.expires <= this.now()) {this.pending.delete(nonce);}
      return '表单无效、已过期或已使用，请重新发起检查。';
    }
    // Consume synchronously, before the first await: concurrent callbacks
    // cannot exchange the same credential twice, including failed exchanges.
    this.pending.delete(nonce);
    let outcome = 'invalid_input';
    try {
      if (typeof input.credential === 'string' && input.credential.length <= 8192 &&
          /^(?:gh[pousr]_|github_pat_)[a-z\d_]+$/i.test(input.credential)) {
        const status = await new Promise<number>((resolve, reject) => {
          const call = request(`https://api.github.com/repos/${this.repository}/secret-scanning/alerts?state=open&per_page=1`, {
            headers: { Authorization: `Bearer ${input.credential}`, Accept: 'application/vnd.github+json', 'User-Agent': 'disclaude-private-check', 'X-GitHub-Api-Version': '2022-11-28' },
            signal: AbortSignal.timeout(5000),
          }, response => {
            // Permission verification uses only status, never alert secrets.
            resolve(response.statusCode ?? 0);
            response.destroy();
          });
          call.once('error', reject);
          call.end();
        });
        outcome = status === 200 ? 'read_allowed' : status === 401 || status === 403 || status === 404 ? 'read_denied' : 'upstream_failure';
      }
    } catch {outcome = 'upstream_failure';}
    this.audit({ action: ACTION, actor: binding.actor, chat: binding.chat, outcome, timestamp: this.now(), correlationId: createHash('sha256').update(nonce).digest('hex') });
    return outcome === 'read_allowed'
      ? '检查成功：此凭据具有指定仓库 Secret Scanning 的读取权限。凭据未保存。'
      : outcome === 'read_denied'
        ? '读取未获授权。请检查凭据有效期及仓库 Secret Scanning 只读权限；这不代表没有告警。'
        : '检查未完成，请重新发起检查并确认凭据或稍后重试。';
  }
}

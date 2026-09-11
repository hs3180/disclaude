import { createHash, randomBytes } from 'node:crypto';
import { protectSensitiveValues } from './sensitive-values.js';

export type PrivateActionOutcome = 'succeeded' | 'denied' | 'failed' | 'invalid';
export interface PrivateAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** A code-defined bounded consumer; never a model-selected URL or command. */
  consume(value: string): Promise<Exclude<PrivateActionOutcome, 'invalid'>>;
}
interface Binding { actor: string; chat: string; source: string; card?: string; expires: number }
export interface PrivateActionAudit {
  action: string; actor: string; chat: string; outcome: PrivateActionOutcome; timestamp: number; correlationId: string;
}
export interface PrivateSubmission {
  actor: string; chat: string; card: string; action: unknown; nonce: unknown; source: unknown; value: unknown;
}

/** A one-time handoff to one explicitly installed operation. This module knows
 * neither the transport nor the authentication provider. It never stores an
 * input value or exposes a retrieval API. Forms expire after five minutes;
 * reissue, channel shutdown and process restart revoke outstanding bindings.
 */
export class ActionBoundInput {
  private readonly pending = new Map<string, Binding>();
  readonly action: Readonly<PrivateAction>;
  constructor(action: PrivateAction, private readonly audit: (event: PrivateActionAudit) => void, private readonly now = Date.now) {
    this.action = Object.freeze({ ...action });
  }

  issue(action: string, actor: string, chat: string, source: string): { nonce: string; value: Record<string, string> } {
    if (action !== this.action.id || !actor || !chat || !source) {throw new Error('Private action is unavailable');}
    for (const [nonce, binding] of this.pending) {
      if (binding.expires <= this.now() || (binding.actor === actor && binding.chat === chat)) {this.pending.delete(nonce);}
    }
    if (this.pending.size >= 500) {throw new Error('Too many pending private actions');}
    const nonce = randomBytes(32).toString('hex');
    this.pending.set(nonce, { actor, chat, source, expires: this.now() + 300_000 });
    return { nonce, value: { private_action: action, nonce, source } };
  }

  bindCard(nonce: string, card: string): void {
    const binding = this.pending.get(nonce);
    if (binding && !binding.card && card) {binding.card = card;}
  }
  revoke(): void {this.pending.clear();}

  async submit(input: PrivateSubmission): Promise<PrivateActionOutcome> {
    const nonce = typeof input.nonce === 'string' ? input.nonce : '';
    const binding = this.pending.get(nonce);
    if (!binding || binding.expires <= this.now() || !binding.card || input.action !== this.action.id ||
        binding.actor !== input.actor || binding.chat !== input.chat || binding.card !== input.card || binding.source !== input.source) {
      if (binding && binding.expires <= this.now()) {this.pending.delete(nonce);}
      return 'invalid';
    }
    // Consume before awaiting the operation, including when validation fails.
    this.pending.delete(nonce);
    let outcome: PrivateActionOutcome = 'invalid';
    try {
      if (typeof input.value === 'string' && input.value.length > 0 && input.value.length <= 8192) {
        // Installing a private-input consumer is the harness's explicit
        // declaration. Keep the value protected until that consumer drains.
        const release = protectSensitiveValues([input.value]);
        try {
          const result = await this.action.consume(input.value);
          outcome = result === 'succeeded' || result === 'denied' ? result : 'failed';
        } finally {release();}
      }
    } catch {outcome = 'failed';}
    // Even a faulty consumer cannot reflect its input or error in the result.
    const event = { action: this.action.id, actor: binding.actor, chat: binding.chat, outcome,
      timestamp: this.now(), correlationId: createHash('sha256').update(nonce).digest('hex') };
    try {this.audit(event);} catch { /* Auditing must not expose consumer failures. */ }
    return outcome;
  }
}

import { createHash, randomBytes } from 'node:crypto';
/** A one-time handoff to one explicitly installed operation. This module knows
 * neither the transport nor the authentication provider. It never stores an
 * input value or exposes a retrieval API. Forms expire after five minutes;
 * reissue, channel shutdown and process restart revoke outstanding bindings.
 */
export class ActionBoundInput {
    audit;
    now;
    pending = new Map();
    action;
    constructor(action, audit, now = Date.now) {
        this.audit = audit;
        this.now = now;
        this.action = Object.freeze({ ...action });
    }
    issue(action, actor, chat, source) {
        if (action !== this.action.id || !actor || !chat || !source) {
            throw new Error('Private action is unavailable');
        }
        for (const [nonce, binding] of this.pending) {
            if (binding.expires <= this.now() || (binding.actor === actor && binding.chat === chat)) {
                this.pending.delete(nonce);
            }
        }
        if (this.pending.size >= 500) {
            throw new Error('Too many pending private actions');
        }
        const nonce = randomBytes(32).toString('hex');
        this.pending.set(nonce, { actor, chat, source, expires: this.now() + 300_000 });
        return { nonce, value: { private_action: action, nonce, source } };
    }
    bindCard(nonce, card) {
        const binding = this.pending.get(nonce);
        if (binding && !binding.card && card) {
            binding.card = card;
        }
    }
    revoke() { this.pending.clear(); }
    async submit(input) {
        const nonce = typeof input.nonce === 'string' ? input.nonce : '';
        const binding = this.pending.get(nonce);
        if (!binding || binding.expires <= this.now() || !binding.card || input.action !== this.action.id ||
            binding.actor !== input.actor || binding.chat !== input.chat || binding.card !== input.card || binding.source !== input.source) {
            if (binding && binding.expires <= this.now()) {
                this.pending.delete(nonce);
            }
            return 'invalid';
        }
        // Consume before awaiting the operation, including when validation fails.
        this.pending.delete(nonce);
        const context = Object.freeze({ action: this.action.id, actor: binding.actor, chat: binding.chat, source: binding.source,
            correlationId: createHash('sha256').update(nonce).digest('hex') });
        let outcome = 'invalid';
        try {
            if (typeof input.value === 'string' && input.value.length > 0 && input.value.length <= 8192) {
                const result = await this.action.consume(input.value, context);
                outcome = result === 'succeeded' || result === 'denied' ? result : 'failed';
            }
        }
        catch {
            outcome = 'failed';
        }
        // Even a faulty consumer cannot reflect its input or error in the result.
        const event = { action: this.action.id, actor: binding.actor, chat: binding.chat, outcome,
            timestamp: this.now(), correlationId: context.correlationId };
        try {
            this.audit(event);
        }
        catch { /* Auditing must not expose consumer failures. */ }
        return outcome;
    }
}

import { createLogger } from "../../../../core/dist/index.js";
const logger = createLogger('WeChatRegistrationRuntime');
/** Watches the host-private registry; account changes do not restart the service. */
export class WeChatRegistrationRuntime {
    registry;
    lifecycle;
    service;
    options;
    running = false;
    timer;
    pending = Promise.resolve();
    registryUnavailable = false;
    active = new Map();
    constructor(registry, lifecycle, service, options = {}) {
        this.registry = registry;
        this.lifecycle = lifecycle;
        this.service = service;
        this.options = options;
    }
    getHealth() {
        return !this.running ? { status: 'stopped' } : this.registryUnavailable
            ? { status: 'degraded', reason: 'registry_unavailable' } : { status: 'healthy' };
    }
    async start() {
        if (this.running) {
            return;
        }
        this.running = true;
        await this.sync();
        if (!this.running) {
            return;
        }
        logger.info({ status: this.getHealth().status }, 'WeChat registration watcher started; use disclaude wechat login to add an account');
        this.schedule();
    }
    schedule() {
        if (!this.running) {
            return;
        }
        this.timer = setTimeout(() => {
            void this.sync().finally(() => this.schedule());
        }, this.options.intervalMs ?? 1000);
        this.timer.unref();
    }
    sync() {
        const operation = this.pending.then(() => this.reconcile());
        this.pending = operation.then(() => {
            if (this.registryUnavailable) {
                logger.info('WeChat registry recovered; registration reconciliation resumed');
            }
            this.registryUnavailable = false;
        }, () => {
            if (!this.registryUnavailable) {
                logger.error('Cannot reconcile WeChat registry; repair or restore its private state/lock. Other channels and existing accounts remain available; retrying automatically');
            }
            this.registryUnavailable = true;
        });
        return this.pending;
    }
    async remove(id) {
        const entry = this.active.get(id);
        try {
            await entry?.channel?.stop();
        }
        finally {
            if (entry?.channel) {
                this.service.unregisterChannel(entry.channel.id);
            }
            this.active.delete(id);
        }
    }
    async reconcile() {
        const accounts = (await this.registry.list()).filter(account => account.enabled);
        if (!this.running) {
            return;
        }
        const wanted = new Map(accounts.map(account => [account.id, account]));
        for (const [id, current] of this.active) {
            if (wanted.get(id)?.generation !== current.generation) {
                await this.remove(id);
            }
        }
        for (const account of accounts) {
            if (!this.running || this.active.has(account.id)) {
                continue;
            }
            const entry = { generation: account.generation };
            this.active.set(account.id, entry);
            try {
                const config = { stateDir: this.registry.stateDir(account), routeTag: this.options.routeTag,
                    ...(account.legacy ? {} : { registrationId: account.id }) };
                entry.channel = await this.lifecycle.createAndWireByType('wechat', config);
                await entry.channel.start();
            }
            catch {
                // Keep failed instances observable, but do not retry a broken login every second.
                logger.error({ registrationId: account.id }, 'WeChat account unavailable; other accounts and registration remain active');
            }
        }
    }
    async stop() {
        this.running = false;
        clearTimeout(this.timer);
        await this.pending;
        for (const id of this.active.keys()) {
            await this.remove(id);
        }
    }
}

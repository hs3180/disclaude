import { createLogger, type IChannel } from '@disclaude/core';
import type { ChannelLifecycleManager } from '../../channel-lifecycle-manager.js';
import { WeChatRegistry } from './registry.js';
import type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatRegistrationRuntime');

/** Watches the host-private registry; account changes do not restart the service. */
export class WeChatRegistrationRuntime {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, { generation: string; channel?: IChannel }>();

  constructor(
    private readonly registry: WeChatRegistry,
    private readonly lifecycle: ChannelLifecycleManager,
    private readonly service: { unregisterChannel(id: string): boolean },
    private readonly options: { routeTag?: string; intervalMs?: number } = {},
  ) {}

  async start(): Promise<void> {
    if (this.running) { return; }
    this.running = true;
    try { await this.sync(); }
    catch (error) { this.running = false; throw error; }
    logger.info('WeChat registration enabled; use disclaude wechat login to add an account');
    this.schedule();
  }

  private schedule(): void {
    if (!this.running) { return; }
    this.timer = setTimeout(() => {
      void this.sync().catch(() => logger.error('Cannot reconcile WeChat registry; existing accounts retained')).finally(() => this.schedule());
    }, this.options.intervalMs ?? 1000);
    this.timer.unref();
  }

  private sync(): Promise<void> {
    const operation = this.pending.then(() => this.reconcile());
    this.pending = operation.catch(() => {});
    return operation;
  }

  private async remove(id: string): Promise<void> {
    const entry = this.active.get(id);
    try { await entry?.channel?.stop(); }
    finally {
      if (entry?.channel) { this.service.unregisterChannel(entry.channel.id); }
      this.active.delete(id);
    }
  }

  private async reconcile(): Promise<void> {
    const accounts = (await this.registry.list()).filter(account => account.enabled);
    if (!this.running) { return; }
    const wanted = new Map(accounts.map(account => [account.id, account]));
    for (const [id, current] of this.active) {
      if (wanted.get(id)?.generation !== current.generation) { await this.remove(id); }
    }
    for (const account of accounts) {
      if (!this.running || this.active.has(account.id)) { continue; }
      const entry: { generation: string; channel?: IChannel } = { generation: account.generation };
      this.active.set(account.id, entry);
      try {
        const config: WeChatChannelConfig = { stateDir: this.registry.stateDir(account), routeTag: this.options.routeTag,
          ...(account.legacy ? {} : { registrationId: account.id }) };
        entry.channel = await this.lifecycle.createAndWireByType('wechat', config);
        await entry.channel.start();
      } catch {
        // Keep failed instances observable, but do not retry a broken login every second.
        logger.error({ registrationId: account.id }, 'WeChat account unavailable; other accounts and registration remain active');
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.pending;
    for (const id of this.active.keys()) { await this.remove(id); }
  }
}

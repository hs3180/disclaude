import { realpathSync } from 'node:fs';
import { resolve, isAbsolute, dirname, basename, join } from 'node:path';
import { validateWeChatAccountName, wechatAccountStateDir } from './account.js';
import type { WeChatChannelConfig } from './types.js';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error(`${field} must be an object`); }
  return value as Record<string, unknown>;
}

function enabled(value: unknown, field: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') { throw new Error(`${field}.enabled must be boolean`); }
  return value !== false;
}

function canonicalDirectory(value: string): string {
  try { return realpathSync(value); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    return join(canonicalDirectory(dirname(value)), basename(value));
  }
}

export function resolveWeChatAccounts(value: unknown): WeChatChannelConfig[] {
  if (value === undefined) { return []; }
  const root = object(value, 'channels.wechat');
  if (!enabled(root.enabled, 'channels.wechat')) { return []; }
  const named = root.accounts !== undefined;
  const unknown = Object.keys(root).filter(key => !(named ? ['enabled', 'accounts'] : ['enabled', 'stateDir', 'routeTag']).includes(key));
  if (unknown.length) { throw new Error(`Unsupported channels.wechat fields: ${unknown.join(', ')}; save credentials with disclaude wechat login`); }
  const accounts = named ? object(root.accounts, 'channels.wechat.accounts') : { '': root };
  const dirs = new Set<string>();
  const results: WeChatChannelConfig[] = [];
  for (const [name, raw] of Object.entries(accounts)) {
    if (named) { validateWeChatAccountName(name); }
    const field = named ? `channels.wechat.accounts.${name}` : 'channels.wechat';
    const account = object(raw, field);
    if (!enabled(account.enabled, field)) { continue; }
    const extra = Object.keys(account).filter(key => !['enabled', 'stateDir', 'routeTag'].includes(key));
    if (extra.length) { throw new Error(`Unsupported ${field} fields: ${extra.join(', ')}`); }
    const stateDir = account.stateDir ?? wechatAccountStateDir(name || undefined);
    if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) { throw new Error(`${field}.stateDir must be an absolute path`); }
    let canonical: string;
    try { canonical = canonicalDirectory(resolve(stateDir)); }
    catch { throw new Error(`${field}.stateDir cannot be resolved`); }
    if (dirs.has(canonical)) { throw new Error(`${field}.stateDir duplicates another enabled WeChat account`); }
    dirs.add(canonical);
    if (account.routeTag !== undefined && (typeof account.routeTag !== 'string' || /[\r\n]/.test(account.routeTag))) { throw new Error(`${field}.routeTag must be a single-line string`); }
    results.push({ stateDir: canonical, ...(name ? { id: `wechat:${name}`, accountId: name } : {}),
      ...(typeof account.routeTag === 'string' ? { routeTag: account.routeTag } : {}) });
  }
  return results;
}

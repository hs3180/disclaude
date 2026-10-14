/**
 * Agent SDK Provider 工厂
 *
 * 提供创建和管理 Provider 实例的统一入口。
 * 支持运行时切换不同的 Agent SDK 实现。
 */

import type { IAgentSDKProvider, ProviderFactory, ProviderConstructor } from './interface.js';
import { createHash } from 'node:crypto';
import type { ProviderInfo } from './types.js';
import type { DeepSeekHarnessProviderOptions } from './providers/deepseek/provider.js';
import {
  ClaudeSDKProvider,
  PiAgentProvider,
  CodexAgentProvider,
  DeepSeekHarnessProvider,
} from './providers/index.js';
import { Config, type AgentConfig } from '../config/index.js';

/**
 * 已注册的 Provider 类型
 */
export type ProviderType = 'claude' | 'pi' | 'codex' | string;

function dshOptions(settings?: AgentConfig): DeepSeekHarnessProviderOptions {
  if (settings === undefined) {
    return {
      provider: Config.DSH_PROVIDER,
      apiKey: Config.DSH_API_KEY,
      dshHome: Config.DSH_HOME || undefined,
      mode: Config.DSH_MODE,
    };
  }
  const native = settings.dsh;
  const keyEnv = native?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  return {
    mode: settings.mode ?? 'standard',
    provider: native?.provider,
    dshHome: native?.dshHome || process.env.DSH_HOME || undefined,
    apiKey: process.env[keyEnv] ?? Config.getGlobalEnv()[keyEnv] ?? '',
  };
}

function providerCacheKey(type: ProviderType, settings?: AgentConfig): string {
  if (type !== 'dsh') {
    return 'default';
  }
  const options = dshOptions(settings);
  return JSON.stringify({
    mode: options.mode ?? 'standard',
    provider: options.provider,
    dshHome: options.dshHome ?? process.env.DSH_HOME,
    // Keep credential values out of cache identifiers.
    credential: createHash('sha256').update(options.apiKey ?? '').digest('hex'),
  });
}

/**
 * Provider 注册表
 */
const providerRegistry = new Map<ProviderType, ProviderFactory>([
  ['claude', () => new ClaudeSDKProvider()],
  ['pi', () => new PiAgentProvider()],
  // Issue #4629 (S1 of #4627); sandbox override #4631 (S4); governance
  // caps wired in #4634 (S7).
  [
    'codex',
    () =>
      new CodexAgentProvider({
        sandboxOverride: Config.CODEX_SANDBOX,
        fullAccess: Config.FULL_ACCESS,
        networkAccess: Config.CODEX_NETWORK_ACCESS,
        maxActiveSessions: Config.CODEX_MAX_ACTIVE_SESSIONS,
        maxConcurrentRuns: Config.CODEX_MAX_CONCURRENT_RUNS,
        transport: Config.CODEX_TRANSPORT,
        model: Config.CODEX_MODEL || undefined,
        modelSource: Config.CODEX_MODEL_SOURCE,
        reasoningEffort: Config.CODEX_REASONING_EFFORT,
        reasoningEffortSource: Config.CODEX_REASONING_EFFORT_SOURCE,
      }),
  ],
  ['dsh', settings => new DeepSeekHarnessProvider(dshOptions(settings))],
]);

/**
 * 默认 Provider 类型
 */
let defaultProviderType: ProviderType = 'claude';

/**
 * 缓存的 Provider 实例
 */
const providerCache = new Map<ProviderType, Map<string, IAgentSDKProvider>>();

/**
 * 获取 Provider 实例
 *
 * 如果缓存中存在则返回缓存的实例，否则创建新实例。
 *
 * @param type - Provider 类型，默认使用 defaultProviderType
 * @returns Provider 实例
 * @throws 如果 Provider 类型未注册
 */
export function getProvider(type?: ProviderType, settings?: AgentConfig): IAgentSDKProvider {
  const providerType = type ?? defaultProviderType;

  // Issue #4224: builtin skills/agents are now discovered in place via the
  // local-plugin option wired in adaptOptions() — no copy-on-start here.

  // 检查缓存
  const cacheKey = providerCacheKey(providerType, settings);
  const cached = providerCache.get(providerType)?.get(cacheKey);
  if (cached) {
    return cached;
  }

  // 获取工厂函数
  const factory = providerRegistry.get(providerType);
  if (!factory) {
    throw new Error(
      `Unknown provider type: ${providerType}. Available: ${[...providerRegistry.keys()].join(', ')}`
    );
  }

  // 创建并缓存实例
  const provider = factory(settings);
  const instances = providerCache.get(providerType) ?? new Map<string, IAgentSDKProvider>();
  instances.set(cacheKey, provider);
  providerCache.set(providerType, instances);

  return provider;
}

/**
 * 注册新的 Provider 类型
 *
 * @param type - Provider 类型名称
 * @param factory - Provider 工厂函数
 */
export function registerProvider(type: ProviderType, factory: ProviderFactory): void {
  providerRegistry.set(type, factory);
  // 清除该类型的缓存
  providerCache.delete(type);
}

/**
 * 注册 Provider 类（构造函数）
 *
 * @param type - Provider 类型名称
 * @param constructor - Provider 构造函数
 */
export function registerProviderClass(type: ProviderType, constructor: ProviderConstructor): void {
  registerProvider(type, () => new constructor());
}

/**
 * 设置默认 Provider 类型
 *
 * @param type - Provider 类型
 */
export function setDefaultProvider(type: ProviderType): void {
  if (!providerRegistry.has(type)) {
    throw new Error(
      `Unknown provider type: ${type}. Available: ${[...providerRegistry.keys()].join(', ')}`
    );
  }
  defaultProviderType = type;
}

/**
 * 获取默认 Provider 类型
 */
export function getDefaultProviderType(): ProviderType {
  return defaultProviderType;
}

/**
 * 获取所有已注册的 Provider 信息
 */
export function getAvailableProviders(): ProviderInfo[] {
  const infos: ProviderInfo[] = [];

  for (const [type, factory] of providerRegistry) {
    try {
      const provider = factory();
      infos.push(provider.getInfo());
    } catch {
      infos.push({
        name: type,
        version: 'unknown',
        available: false,
        unavailableReason: 'Failed to create provider instance',
      });
    }
  }

  return infos;
}

/**
 * 清除 Provider 缓存
 *
 * 用于测试或需要重新创建 Provider 实例时。
 *
 * @param type - 可选，指定要清除的 Provider 类型。不指定则清除全部。
 */
export function clearProviderCache(type?: ProviderType): void {
  if (type) {
    providerCache.delete(type);
  } else {
    providerCache.clear();
  }
}

/**
 * 检查 Provider 是否可用
 *
 * @param type - Provider 类型
 * @returns Provider 是否可用
 */
export function isProviderAvailable(type: ProviderType): boolean {
  const factory = providerRegistry.get(type);
  if (!factory) {
    return false;
  }

  try {
    const provider = factory();
    return provider.validateConfig();
  } catch {
    return false;
  }
}

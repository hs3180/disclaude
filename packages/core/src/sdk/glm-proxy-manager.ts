/**
 * GLM API Proxy 管理器 (Issue #2948)
 *
 * 单例管理器，负责 GLM API 代理的生命周期：
 * - 懒启动：首次请求时自动启动
 * - 缓存：同一 targetUrl 复用同一代理实例
 * - 关闭：进程退出时自动清理
 *
 * @module sdk/glm-proxy-manager
 */

import { GlmApiProxy } from './glm-api-proxy.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GlmProxyManager');

/** 代理实例缓存：targetUrl → proxy */
const proxyCache = new Map<string, GlmApiProxy>();

/**
 * 获取或创建 GLM API 代理
 *
 * 如果已有同一 targetUrl 的代理实例则复用，否则创建新实例。
 * 代理会在首次调用时自动启动。
 *
 * @param targetUrl - 目标 API URL (e.g., 'https://open.bigmodel.cn/api/anthropic')
 * @returns 运行中的代理实例的 URL (http://127.0.0.1:{port})
 */
export async function getOrCreateProxy(targetUrl: string): Promise<string> {
  const normalizedUrl = targetUrl.replace(/\/+$/, '');

  // 检查缓存
  const existing = proxyCache.get(normalizedUrl);
  if (existing) {
    return existing.getUrl();
  }

  // 创建新代理
  logger.info({ targetUrl: normalizedUrl }, 'Creating new GLM API proxy');
  const proxy = new GlmApiProxy({ targetUrl: normalizedUrl });
  await proxy.start();

  // 缓存
  proxyCache.set(normalizedUrl, proxy);

  return proxy.getUrl();
}

/**
 * 停止所有代理实例
 *
 * 用于进程退出时的清理。
 */
export async function stopAllProxies(): Promise<void> {
  const count = proxyCache.size;
  if (count === 0) {
    return;
  }

  logger.info({ count }, 'Stopping all GLM API proxies');

  const promises: Promise<void>[] = [];
  for (const [_url, proxy] of proxyCache) {
    promises.push(proxy.stop());
  }

  await Promise.all(promises);
  proxyCache.clear();

  logger.info('All GLM API proxies stopped');
}

/**
 * 检查是否有活跃的代理实例
 */
export function hasActiveProxies(): boolean {
  return proxyCache.size > 0;
}

/**
 * 获取所有活跃代理的信息（用于诊断）
 */
export function getProxyInfo(): Array<{ targetUrl: string; port: number; requestCount: number }> {
  const info: Array<{ targetUrl: string; port: number; requestCount: number }> = [];
  for (const [url, proxy] of proxyCache) {
    info.push({
      targetUrl: url,
      port: proxy.port,
      requestCount: proxy.getRequestCount(),
    });
  }
  return info;
}

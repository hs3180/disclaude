/**
 * Agent SDK 抽象层
 *
 * 提供与具体 Agent SDK（Claude、OpenAI、GLM 等）无关的统一接口。
 * 上层业务代码通过此模块访问 Agent SDK 功能，
 * 无需关心底层使用的是哪个 SDK。
 *
 * ## 目录结构
 *
 * ```
 * packages/core/src/sdk/
 * ├── index.ts                 # 本文件 - 公开导出
 * ├── types.ts                 # 统一类型定义
 * ├── interface.ts             # IAgentSDKProvider 接口
 * ├── factory.ts               # Provider 工厂
 * └── providers/
 *     ├── index.ts
 *     └── claude/              # Claude SDK 实现
 *         ├── index.ts
 *         ├── provider.ts
 *         ├── message-adapter.ts
 *         └── options-adapter.ts
 * ```
 *
 * ## 使用示例
 *
 * ```typescript
 * import { getProvider } from '@disclaude/core';
 *
 * // 获取默认 Provider
 * const provider = getProvider();
 *
 * // 流式查询（一次性输入可包装为单次 AsyncGenerator）
 * async function* singleInput(text: string) {
 *   yield { role: 'user' as const, content: text };
 * }
 * const result = provider.queryStream(singleInput('Hello'), options);
 * for await (const message of result.iterator) {
 *   console.log(message.content);
 * }
 *
 * // 持续对话流式查询
 * for await (const message of result.iterator) {
 *   console.log(message.content);
 * }
 * ```
 *
 * ## 扩展新 Provider
 *
 * ```typescript
 * import { registerProvider, type IAgentSDKProvider } from '@disclaude/core';
 *
 * class OpenAIProvider implements IAgentSDKProvider {
 *   // 实现接口方法...
 * }
 *
 * registerProvider('openai', () => new OpenAIProvider());
 * ```
 *
 * @module sdk
 */
// ============================================================================
// Provider 导出
// ============================================================================
export { ClaudeSDKProvider, StderrCapture, getErrorStderr, isStartupFailure, snapshotProcessListeners, cleanupNewProcessListeners, SDK_PROCESS_EVENTS } from './providers/index.js';
// ============================================================================
// 工厂函数导出
// ============================================================================
export { getProvider, registerProvider, registerProviderClass, setDefaultProvider, getDefaultProviderType, getAvailableProviders, clearProviderCache, isProviderAvailable, } from './factory.js';

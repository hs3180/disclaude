/**
 * Message ID utilities - classify message IDs as real vs synthetic.
 *
 * 内部多个来源(定时任务、push 端点、CLI、卡片回退等)会生成合成系统消息,
 * 其 ID 形如 `sched-…`、`push_…`、`msg-…` 等。这些 ID 是内部追踪用的,
 * 并非平台真实消息 ID(Feishu 真实 open_message_id 为 `om_` 前缀)。
 *
 * 若合成 ID 被误用作 `threadRoot`,后续回复会把它当成 Feishu open_message_id
 * 调用线程回复 API,触发 HTTP 400 / 错误码 99992354(not a valid open_message_id)。
 *
 * 本模块用于在 `setThreadRoot` 处过滤,确保只把真实入站消息 ID 记为线程根。
 */

/**
 * 合成消息 ID 前缀——内部生成、非真实平台消息 ID。
 * 来源见各生成点,前缀集合为封闭枚举。
 */
const SYNTHETIC_MESSAGE_ID_PREFIXES = [
  'sched-',              // packages/core/src/scheduling/scheduler.ts — 定时任务
  'push_',               // rest-channel.ts / wired-descriptors.ts — push 端点
  'cli-',                // cli-adapter.ts — CLI 适配器
  'msg-',                // chat-agent.ts handleInput 兜底
  'wechat_interactive_', // wired-descriptors.ts — 微信卡片
] as const;

/**
 * 派生后缀——真实 message_id 被改写后(音频/文件派生)不再是合法线程根。
 * 来源:message-handler.ts `${message_id}-audio` / `-file`。
 */
const SYNTHETIC_MESSAGE_ID_SUFFIXES = ['-audio', '-file'] as const;

/**
 * 判断 messageId 是否为内部合成 ID(非真实平台消息 ID)。
 *
 * 采用黑名单策略:仅拒绝已知合成前缀/后缀,放过一切未知 ID——
 * 这样不会误伤其它平台或未来新增的真实消息 ID 格式。
 *
 * @param messageId - 待判定的消息 ID
 * @returns true 表示该 ID 为合成 ID,不应作为线程根
 */
export function isSyntheticMessageId(messageId: string): boolean {
  return (
    SYNTHETIC_MESSAGE_ID_PREFIXES.some((prefix) => messageId.startsWith(prefix)) ||
    SYNTHETIC_MESSAGE_ID_SUFFIXES.some((suffix) => messageId.endsWith(suffix))
  );
}

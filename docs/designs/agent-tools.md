# Agent 工具契约

业务使用一个入口：`tools: ToolDefinition[]`。每个定义提供名称、说明、输入/输出 JSON Schema 和 `execute(input, context)`；adapter 将它接到 Harness 的原生工具协议。

```ts
const readValue: ToolDefinition = {
  name: 'read_value',
  description: 'Read the authorized resource',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string', minLength: 1 } },
    required: ['key'],
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  execute: async ({ key }, { signal }) => {
    signal.throwIfAborted();
    return resource.read(String(key), { signal });
  },
};
provider.queryStream(input, { settingSources: [], tools: [readValue] });
```

## 职责

- 业务绑定已授权的资源，通过 `context.signal` 传递取消；支持时用可选 `context.onProgress` 上报进度。
- 共享层校验原始 draft-07 Schema 与有限、无循环的 JSON，注册时复制声明；不转换类型、不填默认值、不删字段。无效输入不触发操作，无效结果不报告成功。
- adapter 负责原生注册、MCP 包装、namespace、结果呈现和调用 ID。内置工具与外部 MCP 沿用 Harness 自己的 profile/settings，公共查询不提供相应选择或连接字段。
- 业务直接传入本次需要的工具定义，不增加通用黑白名单。`allowedTools` / `disallowedTools` 只属于 `ClaudeSDKProvider` 的原生查询选项；其他 Harness 使用各自的配置。

取消后等待 callback 自身结束并拒绝成功结果。Notebook 的远程执行仍通过 runId 查询/停止；取消 Agent 不代表 kernel 已停止。资源身份与控制权由 Jupyter 契约定义，Harness 调用 ID 留在 adapter 内。

## 现有接入

| Harness          | adapter 内的接入                                                |
| ---------------- | --------------------------------------------------------------- |
| DSH              | agent-scoped 原生 registry；声明跨进程传输，callback 在宿主执行 |
| Pi               | 原生 Agent tools；可选进度回调                                  |
| Codex app-server | dynamic functions；固定 namespace，变更声明需 reset             |
| Claude           | 内部 SDK MCP server，直接声明原始 JSON Schema                   |

Codex exec 无 callback 调度能力，显式拒绝 `tools` 并要求 app-server。DSH/Pi 与原生工具重名时拒绝注册。DSH 只投影已验证的字符串长度约束并保留原始校验，其他不支持的 Schema 关键词拒绝；Claude 不经 Schema → Zod → Schema 转换。

## 迁移

`nativeTools` / `hostTools` 与旧内联 callbacks 合并为 `tools`，类型统一为 `ToolDefinition` / `ToolContext`。旧 `tools` 名称数组改为具体定义；内置 preset 和外部 MCP 在 Harness 自己的配置中设置。旧共享 SDK 工厂、MCP 配置类型和调用 identity 类型移除。JavaScript 的旧字段、名称数组及 preset 明确报错。

依赖 PR 同步迁移字段/imports 并重新验证集成。真实模型及 Notebook/飞书证据始终只属于记录的提交；adapter 回归不代表产品验收通过。

通用 `AgentQueryOptions` / `SdkOptionsExtra` 移除 `allowedTools` / `disallowedTools`，不再将 Claude 名称转译为 Pi 过滤、DSH 限制或 Codex sandbox 政策。非 Claude 的旧 JavaScript 名单字段显式报错；Claude 直接查询仍支持原生名单，聊天默认禁用策略仅在该后端传入。

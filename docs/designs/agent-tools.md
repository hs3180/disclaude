# Agent 工具契约

Agent 查询区分工具来源、业务定义和权限。上层只传业务契约；Harness 的 registry、namespace、MCP 包装对象和调用协议由 provider adapter 管理。

| 查询选项                           | 职责                                | 值                                                      |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `builtinTools`                     | 选择 Harness / profile 已提供的工具 | 工具名称数组，或明确受支持的 provider preset            |
| `hostTools`                        | 注册本次查询的宿主业务工具          | `HostToolDefinition[]`                                  |
| `mcpServers`                       | 连接外部 MCP 服务进程               | 按服务名索引的 stdio 配置                               |
| `allowedTools` / `disallowedTools` | 宿主调用权限与 Harness 原生权限规则 | 名称数组；宿主 deny 优先，空 allow 数组禁用全部宿主工具 |

`builtinTools` 不会限制 `hostTools` 的注册。DSH/Pi 的宿主工具若与已有原生工具重名会明确拒绝；Codex/Claude 在 adapter 内使用独立 namespace。宿主工具权限使用共同定义的 `name`；adapter 在自己的协议边界转换名称，例如 Claude 的 `mcp__disclaude__read_value`。外部 MCP 及 Harness 内置工具仍使用各自的原生权限名称，权限能力遵守该 Harness 的支持范围。

## 宿主业务工具

```ts
const readValue: HostToolDefinition = {
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

provider.queryStream(input, {
  settingSources: [],
  hostTools: [readValue],
});
```

Schema 使用 JSON Schema draft-07；输入根节点必须为 object，成功结果必须是有限、无循环的 JSON 值。共享执行包装器在调用前后验证原始 Schema，不转换类型、不填默认值、不删字段；无效输入不会触发业务操作，无效结果不会作为成功返回。Schema 在查询注册时复制，后续修改原定义不会改变已发布的声明。

`HostToolContext.signal` 必须传递给支持取消的底层操作；包装器等待 callback 自身结束，取消后拒绝报告成功。`invocationId` 和可选的 provider identity 只用于 trace，不能充当 Notebook runId、资源身份、kernel incarnation 或控制权。Pi 的进度通过可选 `context.onProgress` 上报，其他 Harness 可以不提供进度通道。

宿主 callback 始终在 Disclaude 宿主执行，资源与授权通过闭包绑定。Notebook callback 调用共同 Jupyter ports，远程 kernel 的执行和停止仍由 Jupyter 协调层确认；Agent query 的取消不代表 kernel 已停止。

## 适配范围

| Harness          | `hostTools` 注册方式                                          | `builtinTools`                                 | 查询中的外部 `mcpServers`             |
| ---------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| DSH              | agent-scoped `dsh-tools.register`；跨子进程只传声明和宿主调用 | profile 工具名称数组                           | 明确拒绝；已有 profile 保持自己的配置 |
| Pi               | `Agent.initialState.tools` 原生工具                           | Pi 工具名称数组                                | 明确拒绝                              |
| Codex app-server | dynamic function；adapter 使用固定 `disclaude` namespace      | 明确拒绝，沿用 Codex sandbox / permission 配置 | 明确拒绝                              |
| Codex exec       | 明确拒绝宿主 callback，要求 app-server                        | 明确拒绝                                       | 明确拒绝                              |
| Claude           | adapter 内部的 SDK MCP server，原始 JSON Schema 通过 MCP 声明 | 内置名称数组或 `claude_code` preset            | stdio                                 |

DSH 的声明 DSL 比共同 Schema 窄。adapter 只投影已验证的字符串长度关键词，并在原始 Schema 上继续强制执行这些限制；其他不支持的关键词仍明确拒绝。Claude 直接声明原始 Schema，避免 JSON Schema 转 Zod 再转回时丢失约束。Ajv 与 Claude adapter 使用的 MCP SDK 都是显式 runtime dependencies。

## 迁移

此变更统一开发中的工具接入 API，不保留第二套宿主业务契约：

- `nativeTools` → `hostTools`；`NativeAgentTool` → `HostToolDefinition`。
- 查询中的 `tools` → `builtinTools`；Harness SDK 内部的 `tools` 字段由 adapter 转换。
- `InlineToolDefinition` 的 Zod `parameters` / `handler` → JSON Schema `inputSchema` / `outputSchema` 和 `execute(input, context)`。
- 将 `mcpServers` 中的本地内联 callbacks 移到 `hostTools`；`mcpServers` 只保留外部服务配置。
- 移除共享 provider 接口的 `createInlineTool` / `createMcpServer`：业务调用者直接提供契约，不持有 SDK 实例。

旧查询选项对 JavaScript 调用者也明确报错。依赖此 PR 的未合并分支需要在更新后迁移字段和 imports，并重新核验集成。旧提交上的真实模型组件证据仍只属于记录的提交；这次跨 adapter 回归不等于 Feishu / 远程 Jupyter 产品验收通过。

# Fix: 移除默认 MCP 加载后，确保 Codex agent provider 可顺利启动

## 背景

#4459 已移除 `tools.mcpServers` 外部 MCP loader，但 ChatAgent 启动时仍会默认调用 `buildMcpServers()` 注入 `channel-mcp`。当 `agent.agentBackend: codex` 时，`createChannelMcpServer()` 会落到 `CodexAgentProvider.createMcpServer()`；该方法当前按设计直接抛出 not-supported，因此 Codex provider 无法走通生产启动链路。

## 期望行为

在默认 MCP 加载被移除或按 backend 跳过后，配置 `agent.agentBackend: codex` 应能正常启动 Codex agent provider，并能够接收第一轮消息；启动过程不应调用 Codex provider 尚未支持的 `createMcpServer()`。

## 当前调用链

```text
ChatAgent.initializeAgent()
  -> buildMcpServers(...)
  -> createChannelMcpServer()
  -> getProvider().createMcpServer(...)
  -> CodexAgentProvider.createMcpServer()
  -> throws "not supported"
```

相关位置：

- `packages/primary-node/src/agents/chat-agent.ts`：无条件构建并传入默认 MCP servers
- `packages/primary-node/src/agents/mcp-setup.ts`：默认创建 `channel-mcp`
- `packages/core/src/sdk/providers/codex/provider.ts`：`createMcpServer()` 当前明确不支持

## 建议范围

1. 移除 ChatAgent 对默认 `channel-mcp` 的隐式加载，或根据 provider capability 显式跳过 MCP 初始化。
2. Codex 启动链路不得通过空对象、类型断言或捕获异常静默降级；应从源头避免调用不支持的 MCP API。
3. 保持 Claude / Pi 现有行为兼容；如 `channel-mcp` 已迁移为 CLI Skill，应统一使用 runtime-agnostic 的 Skill 路径。
4. 更新 Codex backend 文档中关于 MCP/工具可用性的说明。

## 验收标准

- [ ] 使用 `agent.agentBackend: codex` 启动 Primary Node 成功，不出现 `createMcpServer not supported` 错误
- [ ] Codex provider 能完成第一轮文本消息响应
- [ ] 启动及首轮消息期间不会创建或注入默认 MCP server
- [ ] Claude / Pi backend 的相关回归测试继续通过
- [ ] 增加生产调用链回归测试，覆盖 `PrimaryNode -> ChatAgent -> CodexAgentProvider`
- [ ] `scripts/codex-e2e.mts` 在已安装并登录 Codex CLI 的环境中通过

## 非目标

- 本 issue 不实现 Codex MCP 协议映射
- 本 issue 不恢复已由 #4459 移除的用户自定义 `tools.mcpServers` loader

## 关联 issue

- #4459：移除外部 MCP server loader
- #4627：Codex backend 父特性 / MCP 映射开放问题


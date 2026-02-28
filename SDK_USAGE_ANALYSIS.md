# Claude Agent SDK 使用分析报告

> 分析日期：2026-02-27
> SDK 版本：`@anthropic-ai/claude-agent-sdk@^0.2.19`
> 项目版本：0.3.0

---

## 一、SDK 集成概述

### 1.1 依赖声明

```json
{
  "@anthropic-ai/claude-agent-sdk": "^0.2.19",
  "@anthropic-ai/sdk": "^0.32.0"
}
```

### 1.2 使用分布

| 文件 | 导入内容 | 用途 |
|------|----------|------|
| `base-agent.ts` | `query`, `SDKMessage`, `Query`, `SDKUserMessage` | 核心 Agent 基类 |
| `pilot.ts` | `SDKUserMessage`, `Query` | 对话式 Agent |
| `site-miner.ts` | `query` | 网站挖掘 Agent |
| `session-manager.ts` | `Query` | 会话管理 |
| `message-channel.ts` | `SDKUserMessage` | 消息通道 |
| `feishu-context-mcp.ts` | `tool`, `createSdkMcpServer` | MCP 工具集成 |
| `utils/sdk.ts` | `SDKMessage` | 消息解析 |
| `types/agent.ts` | `SDKUserMessage` | 类型定义 |

---

## 二、核心使用模式

### 2.1 两种查询模式

#### 模式 1: One-shot Query（一次性查询）

```typescript
// 用于任务型 Agent（Evaluator, Executor, Reporter）
protected async *queryOnce(
  input: AgentInput,
  sdkOptions: Record<string, unknown>
): AsyncGenerator<IteratorYieldResult> {
  const queryResult = query({
    prompt: input,  // 字符串或消息数组
    options: sdkOptions,
  });
  const iterator = queryResult[Symbol.asyncIterator]();

  while (true) {
    const result = await iterator.next();
    if (result.done) break;

    const message = result.value;
    const parsed = parseSDKMessage(message);
    yield { parsed, raw: message };
  }
}
```

**特点**：
- 输入是静态的字符串或消息数组
- 每次调用是独立的，无上下文保持
- 适合任务执行、评估、报告等场景

#### 模式 2: Streaming Query（流式查询）

```typescript
// 用于对话型 Agent（Pilot）
protected createQueryStream(
  input: AsyncGenerator<SDKUserMessage>,  // 异步生成器
  sdkOptions: Record<string, unknown>
): QueryStreamResult {
  const queryResult = query({
    prompt: input,  // AsyncGenerator
    options: sdkOptions,
  });

  return {
    query: queryResult,  // 返回 Query 实例用于生命周期控制
    iterator: wrappedIterator(),
  };
}
```

**特点**：
- 输入是 AsyncGenerator，支持动态注入消息
- Query 实例持久化，保持对话上下文
- 适合多轮对话场景

### 2.2 SDK 配置构建

```typescript
protected createSdkOptions(extra: SdkOptionsExtra = {}): Record<string, unknown> {
  const sdkOptions: Record<string, unknown> = {
    cwd: extra.cwd ?? Config.getWorkspaceDir(),
    permissionMode: this.permissionMode,  // 'bypassPermissions'
    settingSources: ['project'],          // 加载项目级 Skills
  };

  // 工具权限控制
  if (extra.allowedTools) sdkOptions.allowedTools = extra.allowedTools;
  if (extra.disallowedTools) sdkOptions.disallowedTools = extra.disallowedTools;

  // MCP 服务器配置
  if (extra.mcpServers) sdkOptions.mcpServers = extra.mcpServers;

  // 环境变量（API Key、Base URL、Debug）
  sdkOptions.env = buildSdkEnv(
    this.apiKey,
    this.apiBaseUrl,
    Config.getGlobalEnv(),
    loggingConfig.sdkDebug
  );

  // 模型选择
  if (this.model) sdkOptions.model = this.model;

  return sdkOptions;
}
```

---

## 三、消息解析与处理

### 3.1 SDK 消息类型

```typescript
// 项目中处理的消息类型
type SDKMessageType =
  | 'assistant'      // AI 响应（文本 + 工具调用）
  | 'tool_progress'  // 工具执行进度
  | 'tool_use_summary' // 工具执行完成
  | 'result'         // 查询完成（成功/失败）
  | 'system'         // 系统消息（压缩、Hook 等）
  | 'user'           // 用户消息回显（通常忽略）
  | 'stream_event';  // 流事件（通常忽略）
```

### 3.2 消息解析器

```typescript
export function parseSDKMessage(message: SDKMessage): ParsedSDKMessage {
  switch (message.type) {
    case 'assistant':
      // 提取工具调用和文本内容
      // 支持 Edit 工具的特殊格式化
    case 'tool_progress':
      // 显示工具执行进度（带时间）
    case 'tool_use_summary':
      // 显示工具执行完成
    case 'result':
      // 显示完成状态和费用统计
    case 'system':
      // 处理压缩、Hook、任务通知
  }
}
```

### 3.3 工具输入格式化

```typescript
// 为不同工具提供人类可读的格式
function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash': return `Running: ${cmd}`;
    case 'Edit': return `Editing: ${filePath}`;
    case 'Read': return `Reading: ${filePath}`;
    case 'Write': return `Writing: ${filePath} (${lineCount} lines)`;
    case 'Grep': return `Searching for "${pattern}"`;
    case 'Glob': return `Finding files: ${pattern}`;
    // ...
  }
}
```

---

## 四、MCP 集成

### 4.1 内联 MCP 服务器

```typescript
// feishu-context-mcp.ts
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// 创建 SDK 兼容的 MCP 服务器
export function createFeishuSdkMcpServer(chatId: string, parentMessageId?: string) {
  return createSdkMcpServer({
    tools: [
      tool({
        name: 'send_user_feedback',
        description: 'Send a message to Feishu chat...',
        parameters: { ... },
        handler: async (params) => { ... },
      }),
      tool({
        name: 'send_file_to_feishu',
        description: 'Send a file to Feishu chat...',
        parameters: { ... },
        handler: async (params) => { ... },
      }),
    ],
  });
}
```

### 4.2 MCP 服务器注入

```typescript
// Pilot 中注入 Feishu MCP
const mcpServers: Record<string, unknown> = {
  'feishu-context': createFeishuSdkMcpServer(chatId, threadRootId),
};

// 合并外部 MCP 服务器
const configuredMcpServers = Config.getMcpServersConfig();
if (configuredMcpServers) {
  for (const [name, config] of Object.entries(configuredMcpServers)) {
    mcpServers[name] = {
      type: 'stdio',
      command: config.command,
      args: config.args || [],
    };
  }
}

const sdkOptions = this.createSdkOptions({ mcpServers });
```

---

## 五、环境变量管理

### 5.1 统一环境构建

```typescript
export function buildSdkEnv(
  apiKey: string,
  apiBaseUrl?: string,
  extraEnv?: Record<string, string | undefined>,
  sdkDebug: boolean = true
): Record<string, string | undefined> {
  const nodeBinDir = getNodeBinDir();
  const newPath = `${nodeBinDir}:${process.env.PATH || ''}`;

  const env: Record<string, string | undefined> = {
    ...extraEnv,
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    PATH: newPath,  // 确保 SDK 子进程能找到 node
    DEBUG_CLAUDE_AGENT_SDK: sdkDebug ? '1' : undefined,
  };

  // 支持自定义 API 端点（GLM 等）
  if (apiBaseUrl) {
    env.ANTHROPIC_BASE_URL = apiBaseUrl;
  }

  return env;
}
```

### 5.2 多 Provider 支持

```typescript
// Config 中检测 Provider
const agentConfig = Config.getAgentConfig();
this.provider = agentConfig.provider;  // 'anthropic' | 'glm'

// GLM 使用不同的 API Base URL
if (provider === 'glm') {
  apiBaseUrl = 'https://open.bigmodel.cn/api/anthropic';
}
```

---

## 六、使用亮点

### 6.1 模板方法模式

`BaseAgent` 使用模板方法模式：
- 基类提供 `createSdkOptions()`、`queryOnce()`、`createQueryStream()`
- 子类只需实现 `getAgentName()` 和特定的查询逻辑

### 6.2 统一的消息解析

`parseSDKMessage()` 统一处理所有 SDK 消息类型：
- 屏蔽底层消息结构差异
- 提供一致的 `ParsedSDKMessage` 接口
- 特殊处理 Edit 工具提供丰富的视觉反馈

### 6.3 环境变量隔离

- SDK 子进程使用独立的环境变量
- 确保 `PATH` 包含 node 路径
- 支持多 Provider 的 API Base URL

### 6.4 生命周期管理

```typescript
// Query 实例可被外部控制
interface QueryStreamResult {
  query: Query;  // 可调用 query.close() 或 query.cancel()
  iterator: AsyncGenerator<IteratorYieldResult>;
}
```

---

## 七、潜在问题与建议

### 7.1 问题：SDK 消息类型未完整覆盖

```typescript
case 'user':
case 'stream_event':
default:
  // 忽略这些消息
  return { type: 'text', content: '' };
```

**建议**：添加日志记录被忽略的消息类型，便于调试。

### 7.2 问题：环境变量优先级复杂

```typescript
// 优先级：extraEnv < process.env < 强制值
const env = {
  ...extraEnv,
  ...process.env,
  ANTHROPIC_API_KEY: apiKey,  // 强制覆盖
};
```

**建议**：添加注释或文档说明优先级规则。

### 7.3 问题：MCP 服务器每次调用都创建新实例

```typescript
// 每次 query 都创建新的 MCP 服务器
const mcpServers = {
  'feishu-context': createFeishuSdkMcpServer(chatId, threadRootId),
};
```

**建议**：考虑缓存 MCP 服务器实例，减少初始化开销。

---

## 八、总结

### 8.1 使用模式总结

| 模式 | 使用场景 | 特点 |
|------|----------|------|
| One-shot Query | 任务执行 | 静态输入，无上下文 |
| Streaming Query | 多轮对话 | 动态输入，持久上下文 |

### 8.2 集成成熟度

| 维度 | 评价 | 说明 |
|------|------|------|
| 核心功能 | ✅ 完善 | 支持两种查询模式 |
| 消息处理 | ✅ 完善 | 统一解析，格式化输出 |
| MCP 集成 | ✅ 完善 | 内联 + stdio 两种模式 |
| 多 Provider | ✅ 支持 | Anthropic + GLM |
| 错误处理 | ⚠️ 可改进 | 部分消息类型被静默忽略 |

### 8.3 评级

**SDK 集成成熟度：A-**

项目对 Claude Agent SDK 的使用整体成熟，采用了良好的设计模式（模板方法、工厂），实现了清晰的消息解析和统一的环境管理。主要改进方向是增强错误日志和优化 MCP 服务器实例管理。

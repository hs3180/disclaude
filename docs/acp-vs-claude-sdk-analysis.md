# ACP 适配器与 Claude Agent SDK 差异分析

> Issue: #1330 - 用 Zed 的 ACP 适配器对接 Claude Code，分析 Zed ACP 方法与 Claude Agent SDK 的差异

## 概述

本文档分析 Zed 的 ACP (Agent Client Protocol) 适配器 (`@zed-industries/claude-agent-acp`) 与直接使用 Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) 两种方式的差异，帮助评估 disclaude 项目的集成策略。

## 背景知识

### ACP (Agent Client Protocol)

ACP 是由 Zed Industries 推出的开放标准协议，用于 AI Agent 与编辑器/IDE 之间的标准化通信。其核心目标是：

- **协议标准化**：定义统一的 Agent-Editor 通信接口
- **跨客户端兼容**：任何 ACP 兼容的客户端都可以使用 ACP Agent
- **功能解耦**：Agent 专注于 AI 逻辑，客户端专注于 UI 交互

协议规范：https://agentclientprotocol.com/

### Claude Agent SDK

Claude Agent SDK 是 Anthropic 官方提供的 TypeScript SDK，用于与 Claude Code 核心功能交互：

- **直接 API 访问**：底层 SDK 调用
- **会话管理**：内置会话持久化
- **工具系统**：MCP 服务器、内联工具支持
- **流式输出**：支持流式消息处理

SDK 文档：https://platform.claude.com/docs/en/agent-sdk/overview

## 架构对比

### disclaude 当前架构（直接 SDK）

```
┌─────────────────────────────────────────────────────────┐
│                     disclaude                           │
├─────────────────────────────────────────────────────────┤
│  IAgentSDKProvider (统一接口)                            │
│       │                                                 │
│       ├── ClaudeSDKProvider                            │
│       │       │                                         │
│       │       ├── query()                              │
│       │       ├── queryStream()                        │
│       │       ├── createInlineTool()                   │
│       │       └── createMcpServer()                    │
│       │                                                 │
│       └── [其他 Provider 预留]                          │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  适配层                                                 │
│  - options-adapter.ts: 统一选项 → SDK 选项              │
│  - message-adapter.ts: SDK 消息 → 统一消息格式          │
├─────────────────────────────────────────────────────────┤
│  @anthropic-ai/claude-agent-sdk (v0.2.62)              │
└─────────────────────────────────────────────────────────┘
```

### ACP 适配器架构

```
┌─────────────────────────────────────────────────────────┐
│              @zed-industries/claude-agent-acp           │
├─────────────────────────────────────────────────────────┤
│  ClaudeAcpAgent implements Agent (ACP 接口)             │
│       │                                                 │
│       ├── initialize()     → 返回能力信息               │
│       ├── newSession()     → 创建会话                   │
│       ├── prompt()         → 处理用户输入               │
│       ├── loadSession()    → 加载历史会话               │
│       ├── listSessions()   → 列出所有会话               │
│       ├── forkSession()    → 分叉会话                   │
│       ├── resumeSession()  → 恢复会话                   │
│       └── closeSession()   → 关闭会话                   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  转换层                                                 │
│  - tools.ts: SDK 工具结果 → ACP ContentBlock            │
│  - settings.ts: Claude Code 设置管理                    │
│  - streamEventToAcpNotifications(): 流事件转换          │
├─────────────────────────────────────────────────────────┤
│  @anthropic-ai/claude-agent-sdk (v0.2.76)              │
└─────────────────────────────────────────────────────────┘
           │
           ▼ (ACP Protocol via stdio/SSE)
┌─────────────────────────────────────────────────────────┐
│              ACP 兼容客户端 (如 Zed Editor)             │
└─────────────────────────────────────────────────────────┘
```

## 关键差异对比

### 1. SDK 版本

| 项目 | SDK 版本 |
|------|---------|
| disclaude | `@anthropic-ai/claude-agent-sdk` **0.2.62** |
| claude-agent-acp | `@anthropic-ai/claude-agent-sdk` **0.2.76** |

ACP 适配器使用更新版本的 SDK，可能包含新功能和 bug 修复。

### 2. 设计模式

| 维度 | disclaude (直接 SDK) | ACP 适配器 |
|------|---------------------|------------|
| **模式** | Provider 抽象模式 | Protocol 适配器模式 |
| **目的** | 支持多 Agent SDK | 标准化 Agent-Editor 通信 |
| **扩展性** | 横向扩展（多 Provider） | 纵向扩展（协议功能） |
| **耦合度** | 与 SDK 紧密耦合 | 与协议松耦合 |

### 3. 会话管理

| 功能 | disclaude | ACP 适配器 |
|------|-----------|------------|
| 创建会话 | SDK 内置 | `newSession()` |
| 加载会话 | SDK 内置 | `loadSession()` |
| 列出会话 | SDK 内置 | `listSessions()` |
| 分叉会话 | 不支持 | `unstable_forkSession()` |
| 恢复会话 | 不支持 | `unstable_resumeSession()` |
| 关闭会话 | 不支持 | `closeSession()` |

**ACP 适配器的会话管理更完善**，提供了完整的生命周期控制。

### 4. 消息处理

**disclaude 方式：**
```typescript
// 直接使用 SDK query()
async *queryOnce(input, options) {
  const queryResult = query({ prompt: input, options });
  for await (const message of queryResult) {
    yield adaptSDKMessage(message);  // 转换为统一格式
  }
}
```

**ACP 适配器方式：**
```typescript
// prompt() 处理 ACP PromptRequest
async prompt(params: PromptRequest) {
  const userMessage = promptToClaude(params);
  session.input.push(userMessage);

  while (true) {
    const { value: message, done } = await session.query.next();
    switch (message.type) {
      case "stream_event":
        for (const notification of streamEventToAcpNotifications(message, ...)) {
          await this.client.sessionUpdate(notification);
        }
        break;
      case "result":
        return { stopReason: "end_turn", usage };
      // ... 更多消息类型处理
    }
  }
}
```

**关键区别：**
- disclaude: 简单迭代，适合 CLI/程序化使用
- ACP: 复杂状态机，支持 ACP 客户端交互（取消、队列、后台任务）

### 5. 工具调用处理

**disclaude：**
- 通过 `createInlineTool()` 创建内联工具
- 通过 `createMcpServer()` 创建 MCP 服务器
- 工具结果直接透传给调用方

**ACP 适配器：**
- 完整的工具结果转换 (`tools.ts`)
- 支持 ACP `ToolCallContent` 格式：
  - `type: "content"` - 文本/图片内容
  - `type: "diff"` - 文件差异
  - `type: "terminal"` - 终端输出
- 工具位置信息 (`ToolCallLocation`) 用于编辑器跳转

```typescript
// ACP 工具信息转换示例
function toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd): ToolInfo {
  switch (toolUse.name) {
    case "Read":
      return {
        title: "Read " + displayPath,
        kind: "read",
        locations: [{ path: input.file_path, line: input.offset ?? 1 }],
        content: [],
      };
    case "Edit":
      return {
        title: "Edit " + displayPath,
        kind: "edit",
        content: [{ type: "diff", path, oldText, newText }],
        locations: [{ path: input.file_path }],
      };
    case "Bash":
      return {
        title: input?.command ?? "Terminal",
        kind: "execute",
        content: supportsTerminalOutput
          ? [{ type: "terminal", terminalId: toolUse.id }]
          : [...],
      };
  }
}
```

### 6. 设置管理

**disclaude：**
- 通过 `AgentQueryOptions.env` 传递配置
- 无持久化设置管理

**ACP 适配器：**
- `SettingsManager` 类实现完整的设置管理
- 支持多源设置合并（优先级递增）：
  1. 用户设置 (`~/.claude/settings.json`)
  2. 项目设置 (`<cwd>/.claude/settings.json`)
  3. 本地项目设置 (`<cwd>/.claude/settings.local.json`)
  4. 企业管理设置 (平台特定路径)
- 文件变更监听和自动重载

### 7. 认证支持

| 认证方式 | disclaude | ACP 适配器 |
|----------|-----------|------------|
| API Key | ✅ `ANTHROPIC_API_KEY` | ✅ |
| Claude Login | ❌ | ✅ Terminal Auth |
| Gateway Auth | ❌ | ✅ 自定义网关 |

ACP 适配器支持更多认证方式，包括通过编辑器终端进行 Claude 登录。

### 8. 功能特性对比

| 特性 | disclaude | ACP 适配器 |
|------|-----------|------------|
| 流式输出 | ✅ | ✅ |
| 内联工具 | ✅ | ✅ |
| MCP 服务器 | ✅ stdio/inline | ✅ http/sse/stdio |
| 图片支持 | ✅ | ✅ |
| @-mentions | ❓ | ✅ |
| 编辑审查 | ❓ | ✅ |
| TODO 列表 | ❓ | ✅ |
| 后台终端 | ❓ | ✅ |
| Slash Commands | ❓ | ✅ |
| 权限模式 | ✅ | ✅ (更细粒度) |
| Prompt 队列 | ❌ | ✅ |
| 后台任务 | ❌ | ✅ |

## 集成策略分析

### 方案 A：保持直接 SDK 使用（当前状态）

**优点：**
- 代码简洁，易于维护
- 无额外依赖
- 完全控制消息流

**缺点：**
- 无法与 ACP 兼容编辑器（如 Zed）集成
- 缺少高级会话管理功能

**适用场景：**
- disclaude 作为独立服务运行
- 仅需基本的 Agent 功能

### 方案 B：添加 ACP 协议支持

**优点：**
- 可与 Zed 等 ACP 兼容编辑器无缝集成
- 获得完整的会话生命周期管理
- 利用 ACP 生态（多客户端支持）

**缺点：**
- 需要实现 ACP `Agent` 接口
- 增加代码复杂度
- 需要处理 ACP 特有的消息格式

**实现方式：**
```typescript
// 新增 AcpProvider 实现 Agent 接口
import { ClaudeAcpAgent, runAcp } from '@zed-industries/claude-agent-acp';

class DisclaudeAcpAgent extends ClaudeAcpAgent {
  // 扩展或覆盖特定方法
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    // 集成 disclaude 特有的处理逻辑
  }
}
```

### 方案 C：参考 ACP 适配器增强现有实现

**优点：**
- 保持现有架构
- 借鉴 ACP 适配器的最佳实践
- 选择性采用功能

**可借鉴的功能：**
1. **设置管理**：引入 `SettingsManager` 类
2. **会话管理**：添加 fork/resume 支持
3. **工具结果转换**：增强 `message-adapter.ts`
4. **认证方式**：支持更多认证选项

**实现步骤：**
1. 升级 SDK 版本至 0.2.76
2. 引入设置管理器
3. 增强会话管理 API
4. 添加 Prompt 队列支持

## 推荐方案

### 短期（推荐方案 C）

1. **升级 SDK 版本**：从 0.2.62 升级到 0.2.76
2. **引入设置管理**：参考 `SettingsManager` 实现多源设置
3. **增强消息适配**：完善工具结果到统一格式的转换

### 中长期（方案 B 作为可选）

如果需要与 Zed 等 ACP 客户端集成，可以：
1. 添加 `@zed-industries/claude-agent-acp` 作为可选依赖
2. 新增 `AcpClaudeProvider` 实现 ACP 协议
3. 通过配置切换 SDK 模式和 ACP 模式

## 代码示例

### 升级 SDK 版本

```json
// packages/core/package.json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.2.76"  // 从 0.2.62 升级
  }
}
```

### 引入设置管理（参考 ACP 实现）

```typescript
// packages/core/src/settings/manager.ts
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ClaudeCodeSettings {
  permissions?: { defaultMode?: string };
  env?: Record<string, string>;
  model?: string;
}

export class SettingsManager {
  private cwd: string;
  private settings: ClaudeCodeSettings = {};

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async initialize(): Promise<void> {
    // 1. 加载用户设置 (~/.claude/settings.json)
    // 2. 加载项目设置 (<cwd>/.claude/settings.json)
    // 3. 加载本地设置 (<cwd>/.claude/settings.local.json)
    // 4. 合并设置
  }

  getSettings(): ClaudeCodeSettings {
    return this.settings;
  }
}
```

### 增强工具结果转换

```typescript
// packages/core/src/sdk/providers/claude/tools-adapter.ts
import type { ToolCallContent, ToolCallLocation } from '../../types.js';

interface ToolInfo {
  title: string;
  kind: 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'think';
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export function toolInfoFromToolUse(toolUse: any, cwd?: string): ToolInfo {
  // 参考 claude-agent-acp/src/tools.ts 实现
  // 将 SDK 工具调用转换为统一的 ToolInfo 格式
}
```

## 结论

disclaude 当前采用直接使用 Claude Agent SDK 的方式，提供了简洁的多 Provider 抽象。ACP 适配器则在 SDK 之上构建了完整的 Agent-Editor 协议实现，支持更丰富的交互场景。

**建议：**
1. **短期**：保持现有架构，升级 SDK 版本，选择性借鉴 ACP 适配器的最佳实践
2. **中期**：根据用户需求决定是否添加 ACP 协议支持
3. **长期**：如果 ACP 成为行业标准，考虑将 ACP 作为主要通信协议

## 参考资料

- [ACP 官网](https://agentclientprotocol.com/)
- [claude-agent-acp 仓库](https://github.com/zed-industries/claude-agent-acp)
- [Claude Agent SDK 文档](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Zed External Agents](https://zed.dev/docs/ai/external-agents)

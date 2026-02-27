# SDK Options Migration Guide

本文档记录 SDK Options 配置格式的历史变更，帮助理解不同版本的配置差异。

## 历史版本

### v1: 原始 SDK 格式 (PR #247 之前)

这是 Claude Agent SDK 的原生配置格式，在 SDK 抽象层引入之前使用。

```typescript
interface LegacyAgentOptions {
  /** 权限模式 - SDK 原生值 */
  permissionMode?: 'default' | 'bypassPermissions';

  /** 设置来源 - 必填 */
  settingSources: string[];

  /** 工作目录 */
  cwd?: string;

  /** 使用的模型 */
  model?: string;

  /** 允许使用的工具列表 */
  allowedTools?: string[];

  /** 禁用的工具列表 */
  disallowedTools?: string[];

  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;

  /** 环境变量 */
  env?: Record<string, string>;
}
```

**使用示例:**

```typescript
const options = {
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
  cwd: '/path/to/project',
  model: 'claude-sonnet-4-20250514',
};
```

### v2: 简化格式 (PR #247 后)

SDK 抽象层引入后的统一配置格式，简化了命名并增加了新字段。

```typescript
interface AgentQueryOptions {
  /** 权限模式 - 简化命名 */
  permissionMode?: 'default' | 'bypass';

  /** 设置来源 - 改为可选 */
  settingSources?: string[];

  /** 上下文隔离模式 - 新增 */
  context?: 'fork' | 'none';

  /** 工作目录 */
  cwd?: string;

  /** 使用的模型 */
  model?: string;

  /** 允许使用的工具列表 */
  allowedTools?: string[];

  /** 禁用的工具列表 */
  disallowedTools?: string[];

  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;

  /** 环境变量 */
  env?: Record<string, string | undefined>;
}
```

**使用示例:**

```typescript
const options: AgentQueryOptions = {
  permissionMode: 'bypass',
  settingSources: ['project'],
  context: 'fork',
};
```

### v3: 当前格式 (Issue #304 revert 后)

恢复为原始 SDK 格式，保持与 Claude Agent SDK 的一致性。

```typescript
interface AgentQueryOptions {
  /** 权限模式 - 恢复原始值 */
  permissionMode?: 'default' | 'bypassPermissions';

  /** 设置来源 - 恢复必填 */
  settingSources: string[];

  /** 工作目录 */
  cwd?: string;

  /** 使用的模型 */
  model?: string;

  /** 允许使用的工具列表 */
  allowedTools?: string[];

  /** 禁用的工具列表 */
  disallowedTools?: string[];

  /** MCP 服务器配置 */
  mcpServers?: Record<string, McpServerConfig>;

  /** 环境变量 */
  env?: Record<string, string | undefined>;
}
```

**使用示例:**

```typescript
const options: AgentQueryOptions = {
  permissionMode: 'bypassPermissions',
  settingSources: ['project'],
};
```

## 字段变更对照表

| 字段 | v1 (原始) | v2 (简化) | v3 (当前) |
|------|-----------|-----------|-----------|
| `permissionMode` | `'bypassPermissions'` | `'bypass'` | `'bypassPermissions'` |
| `settingSources` | 必填 | 可选 | 必填 |
| `context` | 不存在 | `'fork' \| 'none'` | 不存在 |

## 迁移指南

### 从 v2 迁移到 v3

如果你的代码使用了 v2 格式的配置：

```typescript
// v2 格式
const v2Options = {
  permissionMode: 'bypass',
  settingSources: ['project'],
  context: 'fork',
};

// 迁移到 v3
const v3Options: AgentQueryOptions = {
  permissionMode: 'bypassPermissions', // 'bypass' -> 'bypassPermissions'
  settingSources: ['project'],          // 保持不变
  // context 字段已移除
};
```

### 从 v1 迁移到 v3

v1 和 v3 格式相同，无需迁移。

## 类型定义位置

- **当前格式**: `src/sdk/types.ts` - `AgentQueryOptions`
- **配置文件**: `src/config/types.ts` - `AgentConfig`

## 相关

- PR #247: feat(sdk): add Agent SDK abstraction layer (Phase 1)
- Issue #244: feat: 设计 Agent SDK 抽象层
- Issue #304: revert(sdk): 恢复 SDK Options 配置为原始格式

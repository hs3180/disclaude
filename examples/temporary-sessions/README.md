# 临时会话管理系统

基于文件系统的临时会话管理，支持 PR 审核、离线提问、御书房审核等场景。

## 目录结构

```
temporary-sessions/
├── {session-id}/              # 每个会话一个文件夹
│   ├── session.md             # 静态配置
│   └── state.yaml             # 动态状态
│
└── examples/                  # 示例模板
    ├── template/              # 通用模板
    ├── pr-review-example/     # PR 审核示例
    ├── offline-question-example/  # 离线提问示例
    └── agent-confirm-example/ # 御书房审核示例
```

## 使用方法

### 1. 创建新会话

复制模板到新目录：

```bash
cp -r examples/template my-session-123
```

### 2. 编辑 session.md

填写会话配置和内容：

- 设置 `type`、`purpose`、`channel` 等元数据
- 填写会话内容（消息正文、选项等）
- 设置 `expiresIn` 过期时间

### 3. 初始化 state.yaml

```yaml
status: pending
createdAt: 2026-03-10T10:00:00Z
```

### 4. 等待处理

临时会话管理 schedule 会自动：
- 检测 pending 状态的会话
- 创建通道并发送消息
- 更新状态为 sent

### 5. 轮询结果

调用方主动轮询 `state.yaml` 检查状态：
- `replied`: 用户已响应，查看 `response` 字段
- `expired`: 会话已过期

## 会话类型

| 类型 | 用途 | 阻塞 | 通道 |
|------|------|------|------|
| `pr-review` | PR 审核 | ✅ | 新建群聊 |
| `offline-question` | 离线提问 | ❌ | 复用现有 |
| `agent-confirm` | 御书房审核 | ✅ | 复用现有 |

## 状态说明

| 状态 | 含义 |
|------|------|
| `pending` | 等待发送 |
| `sent` | 已发送，等待响应 |
| `replied` | 用户已响应 |
| `expired` | 会话已过期 |

## 相关文档

- [Issue #1317](https://github.com/hs3180/disclaude/issues/1317) - 临时会话管理系统设计
- [schedules/temporary-sessions.md](../../schedules/temporary-sessions.md) - 会话管理 schedule

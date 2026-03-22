---
name: "Temporary Sessions Manager"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions Manager

定期扫描 `workspace/temporary-sessions/` 目录，管理临时会话的生命周期。

## 配置

- **扫描间隔**: 每 5 分钟
- **会话目录**: `workspace/temporary-sessions/`
- **清理阈值**: 24 小时前的 expired 会话

## 执行步骤

### 1. 检查是否有待处理的会话

```bash
# 检查 pending 状态的会话
ls workspace/temporary-sessions/*.json 2>/dev/null | head -5
```

如果没有会话文件，退出本次执行。

### 2. 扫描所有会话文件

读取目录中的所有 JSON 会话文件，按状态分类处理：

```bash
# 列出所有会话文件
ls -la workspace/temporary-sessions/ 2>/dev/null
```

对每个会话文件，读取并解析其内容，检查 `status` 字段。

### 3. 处理 active 会话 - 检查超时

对于每个 `status: "active"` 的会话：

1. 检查 `expiresAt` 是否已过期
2. 如果已过期：
   - 将 `status` 更新为 `"expired"`
   - 设置 `expiry.reason` 为 `"timeout"`
   - 设置 `expiry.expiredAt` 为当前时间
   - 更新 `updatedAt` 为当前时间
3. 如果有 `chatId`，发送超时通知消息

**超时通知卡片**（format: "card"）：
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "⏰ 会话已过期", "tag": "plain_text"}, "template": "orange"},
  "elements": [
    {"tag": "markdown", "content": "会话 **{id}** 因超时已自动关闭。\n\n原始消息:\n> {message}"},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "如需重新发起，请使用 /temporary-session 命令"}
    ]}
  ]
}
```

### 4. 处理 pending 会话 - 发送通知

对于每个 `status: "pending"` 的会话：

1. 检查 `expiresAt` 是否已过期
2. 如果已过期，直接标记为 `"expired"` (reason: `"timeout"`)
3. 如果未过期，**暂不处理**（等待创建者通过 Skill 激活）

> **注意**: pending 状态的会话不会自动激活。激活由创建者通过
> `/temporary-session` Skill 手动触发，或由其他 schedule 触发。

### 5. 清理过期的会话

删除 24 小时前就已过期（expired）的会话文件：

```bash
# 查找并删除 24 小时前的 expired 会话
find workspace/temporary-sessions/ -name "*.json" -mtime +1 -exec rm {} \;
```

**判断条件**:
- `status` 为 `"expired"`
- `updatedAt` 距今超过 24 小时

### 6. 输出报告

向 chatId 发送简要报告：

**正常情况**（无需操作时）: 不发送消息（避免噪音）

**有处理结果时**（format: "card"）:
```json
{
  "config": {"wide_screen_mode": true},
  "header": {"title": {"content": "📋 临时会话管理报告", "tag": "plain_text"}, "template": "blue"},
  "elements": [
    {"tag": "markdown", "content": "**本次扫描结果**:\n- ⏰ 超时过期: {timeoutCount} 个\n- 🧹 已清理: {cleanupCount} 个\n- 📌 活跃会话: {activeCount} 个\n- ⏳ 等待激活: {pendingCount} 个"},
    {"tag": "hr"},
    {"tag": "note", "elements": [
      {"tag": "plain_text", "content": "下次扫描: 5 分钟后"}
    ]}
  ]
}
```

## 状态转换规则

```
pending ──(Skill 激活)──> active ──(用户响应)──> expired (reason: response)
                            │
                            └──(超时)──> expired (reason: timeout)

pending ──(超时)──> expired (reason: timeout)

任意状态 ──(取消)──> expired (reason: cancelled)
```

## 错误处理

- 如果会话文件格式错误，记录错误但不删除文件
- 如果发送通知失败，不影响会话状态更新
- 如果目录不存在，跳过本次执行（不报错）

## 注意事项

1. **幂等性**: 多次执行不会产生副作用
2. **最小干扰**: 只在有必要时才发送通知
3. **安全清理**: 只清理已确认过期的会话
4. **不创建会话**: 此 schedule 只管理现有会话，不创建新会话

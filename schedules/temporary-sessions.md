---
name: "Temporary Sessions Manager"
cron: "*/30 * * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
---

# Temporary Sessions Manager

管理临时会话的生命周期：创建群聊、发送消息、检测超时。

## 执行步骤

### 1. 扫描待处理的会话

读取 `workspace/temporary-sessions/` 目录，查找所有会话文件夹。

### 2. 处理 pending 状态的会话

对于每个 `status: pending` 的会话：

1. 读取 `session.md` 获取会话配置（channel、message、options）
2. 根据 `channel.type` 决定消息发送方式：
   - `group`: 使用 `start_group_discussion` 创建新群聊
   - `existing`: 使用现有 chatId 发送消息
   - `private`: 发送私聊消息
3. 发送交互式卡片（包含 options 中定义的按钮）
4. 更新 `state.yaml`:
   - `status: sent`
   - `chatId: <创建/使用的群聊ID>`
   - `messageId: <发送消息的ID>`
   - `sentAt: <当前时间>`

### 3. 检查 sent 状态的会话是否超时

对于每个 `status: sent` 的会话：

1. 比较 `expiresAt` 与当前时间
2. 如果已超时，更新 `state.yaml`:
   - `status: expired`

### 4. 清理过期会话（可选）

删除状态为 `expired` 或 `replied` 且超过 7 天的会话文件夹。

## 状态机

```
pending → sent → replied (用户已响应)
              ↘ expired (超时未响应)
```

## 错误处理

- 如果会话文件夹不完整（缺少 session.md 或 state.yaml），记录警告并跳过
- 如果群聊创建失败，保留 `pending` 状态，下次执行时重试
- 如果消息发送失败但群聊已创建，更新 chatId 但保留 pending 状态

## 注意事项

1. **幂等性**: 重复执行不会创建重复的群聊或消息
2. **超时检查**: 每 30 秒执行一次，确保及时检测超时
3. **默认禁用**: 此 schedule 默认禁用（enabled: false），需要在创建临时会话后手动启用

---
name: "Self-Experience (Dogfooding)"
cron: "0 20 * * 1"
enabled: false
blocking: true
chatId: "oc_your_dev_group_id"
createdAt: "2026-05-04T00:00:00.000Z"
---

# Self-Experience 自动测试

每周一 20:00 自动以新用户视角体验系统功能，生成结构化反馈报告。

## 执行步骤

### 1. 调用 self-experience skill

使用 `self-experience` skill 进行自我体验测试：

要求：
1. 发现当前可用的功能和 Skills
2. 模拟新用户视角体验 3-5 个功能
3. 包含边界场景和错误处理测试
4. 生成结构化反馈报告
5. 使用 send_user_feedback 发送到当前 chatId

### 2. 检查最近变更

```bash
git log --since="7 days ago" --oneline | head -20
```

重点关注本周新增或变更的功能。

### 3. 发送报告

使用 `send_user_feedback` 发送到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{report_content}"
})
```

## 错误处理

1. 如果 skill 执行失败，记录错误日志
2. 如果 `send_user_feedback` 失败，记录日志
3. 如果没有发现新变更，体验核心功能

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的开发者群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（默认每周一次）

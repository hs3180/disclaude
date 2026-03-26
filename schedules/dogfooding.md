---
name: "Dogfooding 自我体验"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_target_chat_id"
createdAt: "2026-03-26T00:00:00.000Z"
---

# Dogfooding 自我体验

每周一上午 10:00 自动执行自我体验流程，以新用户视角探索 disclaude 功能并生成反馈报告。

## 执行步骤

### 1. 环境检测

```bash
# 获取当前版本
cat package.json | grep '"version"' | head -1

# 获取最近变更
git log --oneline -10
```

### 2. 执行自我体验

使用 `dogfooding` skill 进行自主探索：

1. 根据日期选择 5-8 个不同的探索活动
2. 以新用户视角体验各项功能
3. 记录观察结果和发现的问题

### 3. 生成反馈报告

将探索结果整理为结构化报告，包含：
- 📊 总览（活动数量、问题数、评分）
- 🔍 活动详情
- 🐛 发现的问题
- ✨ 亮点
- 📋 总结与建议

### 4. 发送报告

使用 `send_user_feedback` 发送报告到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{feedback_report}"
})
```

## 配置说明

使用前需要修改：
1. `chatId`: 替换为接收报告的群组/用户 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整执行时间（默认每周一 10:00）

## 错误处理

1. 如果版本检测失败，使用日期作为标识继续执行
2. 如果某个探索活动失败，跳过并记录，不影响其他活动
3. 如果报告发送失败，将报告保存到 `workspace/dogfooding/` 目录

## 注意事项

- 每次执行选择不同的探索活动，确保覆盖面
- 报告应包含具体、可操作的建议
- 不要在探索过程中修改任何代码或配置

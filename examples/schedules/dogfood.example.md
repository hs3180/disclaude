---
name: "Dogfood Self-Test"
cron: "0 14 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-04-25T00:00:00.000Z"
---

# Dogfood 自我体验测试

每周一下午 2:00 自动运行自我体验测试，以拟人化方式探索自身功能并生成体验报告。

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 检查历史报告

```bash
ls -la workspace/dogfood/*.md 2>/dev/null | tail -5
```

如果最近 12 小时内已有报告，跳过本次执行。

### 2. 选择测试类别

查看上次的报告，选择一个不同的功能类别进行测试：
- Skill System
- Chat & Conversation
- Tool Usage
- Scheduling
- Error Handling
- Configuration
- Documentation
- Integration

### 3. 执行探索测试

使用 `dogfood` skill 进行拟人化探索：
1. 以新用户视角尝试使用选定的功能
2. 记录体验过程中的发现
3. 注意用户引导、易用性和潜在问题

### 4. 生成报告

将报告保存到 `workspace/dogfood/report-{date}-{category}.md`

### 5. 发送摘要

使用 `send_user_feedback` 发送测试摘要到当前 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{生成的摘要}"
})
```

### 6. 提交 Bug（如有）

如果发现实际 bug，使用 `gh issue create` 提交 Issue。

## 错误处理

1. 如果 workspace/dogfood/ 不存在，自动创建
2. 如果探索过程出错，记录错误并继续
3. 如果 `send_user_feedback` 失败，仍然保存报告
4. 如果 GitHub Issue 创建失败，在报告中注明

## 相关

- Issue #1560: 自动体验最新版本 — 拟人化模拟活动与自反馈机制
- Skill: dogfood

---
name: "Dogfood 自体验"
cron: "0 14 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-24T00:00:00.000Z"
---

# Dogfood 自体验 — 定时自我体验与反馈

每周一 14:00 自动触发 disclaude 自体验流程，以新用户视角探索功能并生成反馈报告。

## 执行步骤

### 1. 检查上次体验记录

读取上次的 dogfood 报告，避免重复体验相同功能：

```bash
# 查找历史 dogfood 报告
ls workspace/logs/*dogfood* 2>/dev/null || echo "No previous sessions"
```

如果存在历史报告，读取并记录已测试的活动，确保本次选择不同的活动。

### 2. 执行自体验

使用 `dogfood` skill 执行自体验：

1. 发现所有可用 skill
2. 自主选择 2-3 个活动进行体验
3. 模拟真实用户交互
4. 记录观察结果

### 3. 生成并提交报告

1. 生成结构化反馈报告
2. 使用 `send_user_feedback` 发送报告到当前 chatId
3. 仅对严重问题（🔴 High severity）创建 GitHub Issue

## 体验策略

按周一轮换体验重点：

| 周次 | 体验重点 |
|------|----------|
| 第 1 周 | 核心 skill 交互体验（chat, feedback, next-step） |
| 第 2 周 | 分析类 skill（daily-chat-review, daily-soul-question, evaluator） |
| 第 3 周 | 工具类 skill（site-miner, playwright-agent, github-app） |
| 第 4 周 | 跨功能集成测试（skill 间协作、edge case） |

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的目标群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整时间（默认每周一 14:00）

## 注意事项

- 每次体验至少选择 2 个不同的活动
- 避免连续两次体验相同的 skill
- 优先测试最近有代码变更的功能
- 报告应包含具体的观察和可操作的建议

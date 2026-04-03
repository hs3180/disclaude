---
name: "Disclaude 自我体验"
cron: "0 10 * * 1-5"
enabled: false
blocking: true
chatId: "oc_your_target_chat_id"
createdAt: "2026-04-04T00:00:00.000Z"
---

# Disclaude 自我体验（Dogfood）

工作日每天 10:00 自动执行自我体验流程，模拟真实用户行为并生成反馈报告。

## 执行步骤

### 1. 版本感知

检查当前部署版本和最近变更：

```bash
git log --oneline -10
git rev-parse --short HEAD
```

读取上次体验状态（用于活动轮换）：

```bash
cat workspace/data/dogfood-last-run.json 2>/dev/null || echo "No previous run"
```

### 2. 执行体验

使用 `dogfood` skill 执行自我体验：

1. 发现当前可用功能（读取 SKILL.md 列表、CLAUDE.md）
2. 基于轮换策略选择 3-5 个不同的活动
3. 执行每个活动并记录观察
4. 生成结构化反馈报告

### 3. 发送报告

使用 `send_user_feedback` 发送反馈报告到配置的 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "{feedback_report}"
})
```

### 4. 更新状态

更新体验状态文件用于下次轮换：

```bash
echo '{"lastRunAt": "...", "activities": [...], "gitHash": "..."}' > workspace/data/dogfood-last-run.json
```

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的接收反馈的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整执行时间

## 注意事项

- 每次执行大约需要 5-10 分钟
- 确保在低峰期执行，避免影响正常使用
- 报告会包含评分、亮点、改进建议和发现的问题
- 如果连续两次体验结果高度相似，考虑调整轮换策略

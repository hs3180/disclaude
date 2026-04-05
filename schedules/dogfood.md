---
name: "Dogfood 自我体验"
cron: "0 10 * * 1-5"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-05T00:00:00.000Z"
---

# Dogfood 自我体验 — 定时执行

工作日每天 10:00 自动执行自我体验，模拟用户交互并生成反馈报告。

## 配置

- **执行频率**: 工作日每天一次 (周一至周五 10:00)
- **体验活动数**: 3-5 个
- **报告存储**: workspace/dogfood/

## 执行步骤

### 1. 准备报告目录

```bash
mkdir -p workspace/dogfood
```

### 2. 执行自我体验

使用 `dogfood` skill 执行完整的自我体验流程：

- 评估当前部署能力
- 根据星期几选择体验活动类别
- 模拟 3-5 个用户交互场景
- 生成结构化反馈报告

### 3. 存储报告

将报告保存到 workspace/dogfood/ 目录：

```
文件名: workspace/dogfood/{YYYY-MM-DD}.md
```

### 4. 发送报告

使用 `send_user_feedback` 将报告摘要发送到配置的 chatId。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的接收报告的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整执行时间

## 错误处理

1. 如果 workspace 目录不可写，跳过本地存储，仅发送报告
2. 如果 `send_user_feedback` 失败，将报告保存到 workspace/dogfood/ 供后续查看
3. 如果体验过程中遇到错误，记录到报告中作为发现的问题

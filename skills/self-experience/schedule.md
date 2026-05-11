---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
modelTier: "low"
---

# 自我体验 — 定时执行

每周一 10:00 使用 `self-experience` skill 从新用户视角探索自身功能，生成结构化反馈报告。

## 执行

使用 `self-experience` skill 自动探索功能、模拟交互、生成报告。

参数：
- **目标群 chatId**: {controlChannelChatId}

### 执行前检查

1. 检查上次自我体验报告（避免重复）：

```bash
cat workspace/chat/{chatId}.md 2>/dev/null | grep -A 5 "Self-Experience Report" | tail -20 || echo "No previous report"
```

2. 如果最近 3 天内已生成过报告 → 跳过本次执行

### 关注重点轮换

| 周次 | 关注重点 |
|------|----------|
| 第1周 | 核心交互场景（基础对话、skill 调用） |
| 第2周 | 边缘案例（长输入、特殊字符、多语言混合） |
| 第3周 | 多功能组合（skill + 定时任务 + 反馈闭环） |
| 第4周 | 新用户体验（首次使用引导、错误恢复） |

### 输出

生成结构化反馈报告并通过 `send_user_feedback` 发送到目标群。

## 安装说明

将此文件复制到 `schedules/self-experience/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的目标群 chatId |

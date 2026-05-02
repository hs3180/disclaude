---
name: "自我体验报告"
cron: "0 10 * * 1"  # Every Monday at 10:00 AM
enabled: true
blocking: true
chatId: "{targetChatId}"
---

# Self-Experience — 定期自我体检

每周一 10:00 执行一次自我体验报告。

## 执行

使用 `self-experience` skill 以新用户视角体验系统功能，生成自我体检报告。

参数：
- **体验视角**: 新用户首次使用
- **分析范围**: 最近 7 天的交互记录
- **模拟场景数**: 3-5 个

## 安装说明

将此文件复制到 `schedules/self-experience/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{targetChatId}` | 实际的目标群聊 chatId |

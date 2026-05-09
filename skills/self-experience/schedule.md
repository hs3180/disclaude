---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Self-Experience — 定时执行

每周一 10:00 使用 `self-experience` skill 自动体验系统功能并生成反馈报告。

## 执行

使用 `self-experience` skill 从新用户视角探索功能，发现问题和改进点。

参数：
- **目标群 chatId**: {controlChannelChatId}

### 前置检查

执行前检查是否需要运行：

```bash
# 检查最近的自我体验报告
ls -la workspace/self-experience-reports/ 2>/dev/null | tail -5 || echo "No previous reports"
```

- 如果最近 7 天内已有报告 → 检查版本是否更新
- 如果版本未变化 → 跳过（避免重复报告）

### 版本对比

```bash
# 获取当前版本
cat package.json | grep '"version"'
```

- 将当前版本与上次报告的版本对比
- 如果版本变化 → 执行完整体验
- 如果版本未变化 → 跳过或执行轻量检查

## 安装说明

将此文件复制到 `schedules/self-experience/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的群组 chatId |

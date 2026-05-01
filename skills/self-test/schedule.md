---
name: "Self-Test (Dogfooding)"
cron: "0 10 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Self-Test — 定期自测

每周一上午 10:00 自动执行 self-test skill，体验最新版本功能并生成反馈报告。

## 执行

使用 `self-test` skill 执行自我测试。

参数：
- **测试范围**: 全部 skills + 最近变更
- **输出**: 结构化反馈报告

## 安装说明

将此文件复制到 `schedules/self-test/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |

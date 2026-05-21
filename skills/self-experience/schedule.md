---
name: "Self-Experience Dogfooding"
cron: "0 3 * * 1"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Self-Experience Dogfooding — 定时执行

每周一凌晨 3:00 使用 `self-experience` skill 进行自我体验测试。

## 执行

使用 `self-experience` skill 从新用户视角探索所有功能。

参数：
- **目标群 chatId**: {controlChannelChatId}

### 执行步骤

1. **发现功能**: 扫描 skills/ 目录，列出所有可用技能
2. **设计场景**: 从新用户、高级用户、非技术用户等视角设计探索场景
3. **模拟交互**: 对每个场景进行模拟测试，记录结果
4. **边缘测试**: 测试空输入、超长文本、中英混合等边界情况
5. **生成报告**: 汇总所有发现，生成结构化反馈报告
6. **保存报告**: 写入 `workspace/self-experience/report-{date}.md`

### 输出

生成的报告应包含：
- 功能覆盖率统计
- 亮点和良好体验
- 发现的问题（按严重程度分类）
- 改进建议（按优先级排列）

## 安装说明

将此文件复制到 `schedules/self-experience/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的通知群组 chatId |

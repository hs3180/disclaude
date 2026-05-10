---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
modelTier: "low"
chatId: "{controlChannelChatId}"
---

# PR Scanner — 定时扫描与审查

每 30 分钟扫描 `{repo}` 的 open PR，为新 PR 创建审查群并执行自动 review。

## 执行

使用 `pr-scanner` skill 扫描仓库 `{repo}` 的 open PR。

参数：
- **仓库**: {repo}
- **控制频道**: {controlChannelChatId}
- **并发上限**: 3

## 执行流程

1. 读取 `workspace/bot-chat-mapping.json` 映射表
2. 获取 `{repo}` 的 open PR 列表
3. 对比映射表，识别新 PR 和已有群的 PR
4. 对已有群的 PR：检测是否已 closed/merged（不自动解散群）
5. 对新 PR（并发上限内）：
   - 通过 `lark-cli im chat create` 创建审查群
   - 写入映射表（key: `pr-{number}`, purpose: `pr-review`）
   - 获取 PR 详细信息和 diff
   - 执行自动 review（变更概要、关键改动、潜在问题、测试覆盖）
   - 向审查群发送 review 卡片
   - 向控制频道汇报结果

## Review 输出格式

对每个新 PR 生成结构化 review：
- **分级**: ✅ Approve / ⚠️ Request Changes / 💬 Comment
- **变更概要**: 修改文件和规模
- **关键改动**: 核心逻辑变更
- **潜在问题**: 需要关注的点
- **建议**: 改进建议

## 错误处理

- gh 命令失败 → 记录错误并退出
- 映射文件读取失败 → 视为空表（全量扫描）
- 群创建失败 → 跳过该 PR
- Diff 过大 → 降级为文件列表 + stat review

## 安装说明

将此文件复制到 `schedules/pr-scanner/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId（用于接收扫描结果通知） |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |

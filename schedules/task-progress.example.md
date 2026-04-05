---
name: "Task Progress Monitor"
cron: "0 */5 * * * *"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-05T00:00:00.000Z"
---

# Task Progress Monitor

定期检查所有活跃的 deep-task 任务，发送进度报告。

## 配置

- **检查间隔**: 每 5 分钟
- **默认状态**: 禁用（需手动启用）
- **监控目录**: `workspace/tasks/`

## 执行步骤

使用 `task-progress` skill 检查活跃任务并发送进度报告：

```
/task-progress
```

## 启用方式

将 `enabled` 改为 `true` 即可启用：

```yaml
enabled: true
```

## 注意事项

1. **默认禁用**: 此 schedule 默认禁用，避免在不需要时产生不必要的通知
2. **无侵入**: 仅读取任务文件，不修改任何内容
3. **智能汇报**: 使用 LLM 判断是否有值得汇报的进展
4. **与 reporter skill 互补**: reporter 处理完成通知，此 schedule 处理执行中进度

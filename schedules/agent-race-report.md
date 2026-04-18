---
name: "Agent Race Report"
cron: "0 9 * * 1"
enabled: true
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-19T00:00:00.000Z"
---

# Agent Race Report

每周一上午 9 点自动分析过去 7 天的聊天记录，对比不同模型/provider 的表现，生成周报发送到群聊。

## 执行步骤

### 1. 获取聊天记录文件

```bash
ls workspace/chat/*.md 2>/dev/null || echo "No chat files found"
ls workspace/logs/**/*.md 2>/dev/null || echo "No log files found"
```

如果两个目录都不存在或为空，跳过本次执行。

### 2. 使用 agent-race-report skill 分析

调用 `agent-race-report` skill 进行分析：

1. 读取 `workspace/chat/` 和 `workspace/logs/` 下的聊天记录
2. 从消息元数据中提取性能指标（provider, model, elapsedMs, costUsd, inputTokens, outputTokens）
3. 按 provider + model 聚合统计：平均响应时间、成本、token 用量、成功率
4. 按任务类型分类统计
5. 生成对比报告

### 3. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId。

## 报告格式

```markdown
## 🏁 Agent Framework 表现周报

**报告时间**: [Timestamp]
**分析范围**: 最近 7 天
**分析消息数**: [Total messages]
**模型数量**: [Number of distinct models]

---

### 📊 模型表现概览

[排名表格]

### 💰 成本分析

[成本对比表格]

### ⏱️ 效率分析

[效率对比表格]

### 🎯 任务类型匹配度

[任务类型最佳模型推荐]

### 💡 洞察与建议

[基于数据的建议]
```

## 数据来源

聊天记录中的消息可能包含以下元数据（用于提取性能指标）：

| 字段 | 格式 | 说明 |
|------|------|------|
| provider | `provider: anthropic` | AI 服务商 |
| model | `model: claude-sonnet-4-20250514` | 模型名称 |
| elapsedMs | `elapsedMs: 12340` | 响应耗时(毫秒) |
| costUsd | `costUsd: 0.0523` | 费用(美元) |
| inputTokens | `inputTokens: 2048` | 输入 token 数 |
| outputTokens | `outputTokens: 1024` | 输出 token 数 |

## 错误处理

1. 如果聊天记录文件读取失败，跳过该文件继续处理
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果没有找到性能数据，发送 "无数据" 通知
4. 如果某模型样本量 < 5 次，在报告中标注 "样本不足"

## 注意事项

1. **零代码侵入**: 不修改任何核心代码
2. **数据驱动**: 所有结论基于实际聊天数据
3. **公平对比**: 不偏袒任何模型
4. **样本量**: 样本不足时不做排名
5. **不创建新 Schedule**: 这是定时任务执行环境的规则

---
name: "Agent 赛马报告"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-05-01T00:00:00.000Z"
---

# Agent 赛马报告

每周一 09:00 分析过去 7 天的聊天记录，评估各 Agent/模型的服务质量并生成对比报告。

**关联 Issue**: #1334
**Milestone**: Agent 质量评估

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 检查聊天日志

```bash
ls workspace/logs/**/*.md 2>/dev/null || echo "No log files found"
```

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行。

### 2. 使用 agent-race-report skill

触发 `agent-race-report` skill，分析最近 7 天的聊天记录。

分析维度：
- 响应效率 (25%)
- 任务完成率 (30%)
- 用户满意度 (25%)
- 错误恢复率 (10%)
- 工具使用效率 (10%)

### 3. 发送报告

使用 `send_user_feedback` 将赛马报告发送到配置的 chatId。

## 错误处理

1. 如果日志文件不足（< 5 个对话），在报告中标注样本量有限
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果没有检测到可比较的 Agent，仍生成单 Agent 的质量评估

## 示例输出

```
## 🏁 Agent Performance Report (赛马报告)

**Analysis Period**: 2026-04-21 ~ 2026-04-28
**Chats Analyzed**: 12
**Messages Analyzed**: 342
**Agents Compared**: 2

---

### 📊 Overall Ranking

| Rank | Agent/Model | Score | Strengths |
|------|-------------|-------|-----------|
| 1 | Claude Sonnet | 4.1/5 | Creative tasks, nuanced understanding |
| 2 | GLM-4 | 3.5/5 | Fast responses, structured output |

---

### 🔑 Key Findings

1. **Claude Sonnet has higher task completion rate** (87% vs 72%)
2. **GLM-4 responds faster** but needs more correction turns
3. Both struggle with complex multi-step tool chains

---

### 💡 Recommendations

1. Use Claude Sonnet for creative and analytical tasks
2. Use GLM-4 for quick Q&A and structured data extraction
3. Improve tool chain error handling for both models
```

## 关联

- **核心 Issue**: #1334 (Agent Framework 赛马)
- **参考 Skill**: `agent-race-report`
- **类型**: 定时分析

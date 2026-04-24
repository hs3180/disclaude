---
name: "Agent Benchmark"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-25T00:00:00.000Z"
---

# Agent Framework Benchmark

每周一 10:00 分析过去一周的聊天记录，对比不同 Agent 框架/模型的表现，生成赛马报告。

## 配置

- **仓库**: hs3180/disclaude
- **执行间隔**: 每周一 10:00
- **分析范围**: 最近 7 天
- **默认状态**: `disabled`（需手动启用）

## 前置依赖

- `workspace/logs/` 或 `workspace/chat/` 目录存在聊天记录文件

## 执行步骤

### 1. 检查数据可用性

```bash
ls workspace/logs/**/*.md 2>/dev/null | head -5 || ls workspace/chat/*.md 2>/dev/null | head -5 || echo "No data"
```

如果没有可用的聊天记录文件，跳过本次执行，不发送消息。

### 2. 使用 agent-benchmark Skill 分析

调用 `agent-benchmark` skill 的分析流程：

1. **收集日志** — 读取最近 7 天的聊天记录
2. **提取指标** — 分析每个会话的响应效率、任务完成度、工具使用、错误率
3. **聚合对比** — 按框架/模型分组计算聚合统计
4. **识别特性** — 发现各框架独特的定性强项
5. **生成报告** — 输出结构化赛马报告

详细的指标定义和分析方法见 `skills/agent-benchmark/SKILL.md`。

### 3. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId。

如果数据不足以生成有意义的报告（如会话数 < 3），发送简要说明：

```markdown
## Agent Benchmark — 数据不足

本周可用聊天记录不足以生成有意义的基准报告（需要至少 3 个会话）。

下次分析将在下周一 10:00 自动执行。
```

## 报告格式

详见 `agent-benchmark` skill 中的报告模板。核心结构：

1. **总览表格** — 各框架的关键指标对比
2. **性能详情** — 各框架的优缺点和独特特性
3. **建议** — 基于数据的优化建议
4. **方法论说明** — 数据来源、样本量、分析局限

## 数据存储

将分析结果追加到 `workspace/data/benchmark-history.json`，用于趋势跟踪：

```json
{
  "history": [
    {
      "date": "2026-04-25T10:00:00.000Z",
      "period": "2026-04-18~2026-04-25",
      "sessions": 12,
      "messages": 847,
      "frameworks": ["scheduleAgent", "skillAgent", "chatAgent"],
      "highlights": ["Chat Agent 完成率最高 (90%)", "Schedule Agent 成本最低"]
    }
  ]
}
```

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| 无聊天记录 | 跳过执行，不发送消息 |
| 记录数不足 | 发送简要说明 |
| 文件读取失败 | 跳过该文件，继续处理其他 |
| send_user_feedback 失败 | 记录日志，重试一次 |
| JSON 写入失败 | 仅记录日志，不影响报告发送 |

## 注意事项

1. **零代码侵入**: 不修改任何 agent 或核心代码
2. **不创建新 Schedule**: 这是定时任务执行环境的规则
3. **不发送敏感数据**: 报告中不包含 API 密钥、个人信息等
4. **默认关闭**: `enabled: false`，需手动启用
5. **数据驱动**: 所有结论必须基于聊天记录中的实际数据
6. **趋势跟踪**: 追踪历史分析结果到 benchmark-history.json

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际要接收报告的群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整执行频率（默认每周一 10:00）

## 关联

- Issue: #1334 (Agent Framework 赛马)
- Skill: `agent-benchmark`
- 参考: `daily-chat-review` skill 实现模式

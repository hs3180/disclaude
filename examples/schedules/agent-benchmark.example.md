---
name: "Agent Framework Benchmark"
cron: "0 6 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-05-03T00:00:00.000Z"
---

# Agent Framework Benchmark — 定时框架性能评估

每周一 06:00 回顾聊天记录，对比不同 Agent 框架/模型的表现，识别各自优势和独特能力。

**关联 Issue**: #1334

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 获取聊天日志文件

```bash
ls workspace/logs/**/*.md 2>/dev/null || echo "No log files found"
```

如果 `workspace/logs/` 目录不存在或为空，跳过本次执行。

### 2. 读取聊天日志

使用 `Glob` 工具查找所有日志文件：
```
Glob workspace/logs/**/*.md
```

对于最近 14 天的日志文件，使用 `Read` 工具读取内容。

### 3. 分析 Agent 交互表现

分析所有聊天记录，从以下维度评估各 Agent 框架/模型的表现：

#### 3.1 任务完成度
- 任务是否成功完成 vs 被放弃
- 完成率 = 成功完成数 / 总交互数

#### 3.2 用户满意度
- 正面信号: "谢谢", "很好", "解决了", 任务接受无后续纠正
- 负面信号: "不对", "错了", 同一问题重新提问, 人工纠正

#### 3.3 效率
- 平均对话轮次 (越低越高效)
- 工具调用次数 / 任务复杂度比

#### 3.4 错误率
- 失败、重试、超时、异常
- 错误恢复能力

#### 3.5 独特能力
- 特定框架独有的功能特性
- 无法直接对比的优势

### 4. 生成对比报告

按照以下格式生成报告：

```markdown
## 🏁 Agent Framework Benchmark Report

**分析时间**: [当前时间]
**分析范围**: 最近 14 天
**聊天数量**: [分析的聊天数]
**交互数量**: [总交互数]

---

### 📊 总体表现概览

| 指标 | [Agent A] | [Agent B] | 备注 |
|------|----------|----------|------|
| 交互数量 | X | Y | — |
| 完成率 | X% | Y% | ⬆️ 越高越好 |
| 满意度 | X% | Y% | ⬆️ 越高越好 |
| 平均轮次 | X | Y | ⬇️ 越低越好 |
| 错误率 | X% | Y% | ⬇️ 越低越好 |

---

### 🏆 任务类型对比

[按任务类型分析各框架的优势]

---

### ✨ 独特能力发现

[记录无法直接对比的独特特性]

---

### 📉 常见问题

[各框架的常见问题及出现频率]

---

### 📋 优化建议

[基于分析结果的路由优化和质量改进建议]
```

### 5. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId：

```
send_user_feedback({
  content: [报告内容],
  format: "text",
  chatId: [配置的 chatId]
})
```

### 6. 保存历史数据

将分析结果追加到 `workspace/data/benchmark-history.json`：

```json
{
  "history": [
    {
      "date": "2026-05-03T06:00:00.000Z",
      "period": "14d",
      "chats": 10,
      "interactions": 85,
      "agents": {
        "[agent_a]": { "completionRate": 0.92, "satisfactionRate": 0.88 },
        "[agent_b]": { "completionRate": 0.85, "satisfactionRate": 0.79 }
      }
    }
  ]
}
```

## 错误处理

1. 如果日志文件读取失败，跳过该文件继续处理其他文件
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果数据不足以进行有意义的对比，发送简要报告说明情况

## 验收标准 (来自 Issue #1334)

- [x] 能定时触发 benchmark 分析 (通过 scheduler)
- [x] 能对比不同框架的表现 (通过 LLM 分析聊天记录)
- [x] 能识别框架的独特特性 (AI 驱动的定性分析)
- [x] 零代码侵入 (纯 skill + schedule 实现)
- [x] 历史数据追踪 (benchmark-history.json)

## 关联

- **Issue**: #1334 (Agent Framework 赛马)
- **已否决方案**: PR #1461 (竞速引擎), PR #1467 (内嵌指标采集)
- **参考实现**: daily-chat-review skill

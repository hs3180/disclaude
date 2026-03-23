---
name: "Framework Race Report"
cron: "0 9 * * 1"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
createdAt: "2026-03-24T00:00:00.000Z"
---

# Agent Framework 赛马周报

每周一 9:00 分析过去一周的聊天记录，评估不同 Agent Framework / 模型的服务质量，生成对比报告。

**关联 Issue**: #1334

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 核心设计原则

> **零代码侵入**: 不修改 `BaseAgent` 或任何核心代码，完全基于外部分析聊天记录。

本 schedule 利用 AI 自主分析能力，从真实用户交互中提取多维度的服务质量指标，既能量化对比，也能捕捉定性差异（如独特特性）。

---

## 执行步骤

### 1. 确定分析范围

分析过去 7 天的聊天记录。

```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

### 2. 获取所有聊天日志文件

```bash
find workspace/logs -name "*.md" -type f -mtime -7 2>/dev/null | head -50
```

如果返回为空，说明过去 7 天内没有聊天记录，跳过本次执行。

也可以检查备选路径：

```bash
find workspace/chat -name "*.md" -type f -mtime -7 2>/dev/null | head -50
```

### 3. 读取聊天日志

使用 `Glob` 工具查找所有相关日志文件：
```
Glob workspace/logs/**/*.md
Glob workspace/chat/*.md
```

对于最近 7 天的日志文件，使用 `Read` 工具读取内容。

### 4. 分析聊天记录

#### 4.1 识别 Agent Framework / 模型信息

从聊天记录中提取以下元信息：
- **Agent 类型**: SkillAgent、SubAgent、Pilot 等（从消息元数据或上下文中识别）
- **模型**: claude-sonnet-4、claude-opus-4 等（从系统提示或元数据中识别）
- **Provider**: anthropic、openai 等

识别方式：
- 搜索消息中的 agent 类型标识（如 `SkillAgent`、`Pilot`）
- 搜索模型名称（如 `claude-sonnet`、`claude-opus`、`gpt-4`）
- 搜索 provider 标识（如 `anthropic`、`openai`）
- 如果无法自动识别，根据上下文推断

#### 4.2 提取评估指标

从聊天记录中分析以下维度：

##### A. 响应效率
- **TTFR (Time To First Response)**: 用户消息到 Bot 首次响应的时间
- **总耗时**: 从用户首次请求到任务完成的全部时间
- **轮次效率**: 完成任务所需的对话轮次

##### B. 任务完成度
- **完成率**: 任务是否被成功完成（有明确的完成标记）
- **完成方式**: 一次性完成 vs 需要多轮修正
- **复杂任务处理**: 对于复杂任务（如 PR、Issue 处理）的完成情况

##### C. 用户反馈
- **满意度信号**: 识别正向信号（"谢谢"、"很好"、"不错"、"👍"）和负向信号（"不对"、"重做"、"不是这样的"、"👎"）
- **重复提问**: 同一问题被重复询问（说明上次未解决）
- **纠正频率**: 用户纠正 Agent 输出的频率

##### D. 工具使用效率
- **工具调用次数**: 每个 Agent/模型完成任务所需的工具调用次数
- **工具多样性**: 使用的工具种类数量
- **错误重试**: 工具调用失败后重试的次数

##### E. 错误率
- **任务失败**: 任务最终未能完成
- **超时**: 任务执行超时
- **异常**: 执行过程中出现的错误

#### 4.3 识别独特特性

**重要**: 不同 Agent Framework 之间存在无法通过量化指标比较的独特特性。在分析时特别关注：

- **交互风格差异**: 不同框架的沟通风格（简洁 vs 详细、主动 vs 被动）
- **上下文理解**: 对复杂上下文的理解和记忆能力
- **创意能力**: 在需要创意的任务上的表现差异
- **稳定性**: 在长时间运行任务中的稳定性
- **特殊场景表现**: 在特定任务类型上的突出表现

### 5. 生成对比报告

按照以下格式生成报告：

```markdown
## 🏁 Agent Framework 赛马周报

**分析时间**: {当前时间}
**分析范围**: 过去 7 天 ({起始日期} - {结束日期})
**聊天数量**: {分析的聊天数}
**消息数量**: {总消息数}

---

### 📊 量化对比

#### 响应效率

| Agent/模型 | 平均 TTFR | 平均总耗时 | 平均轮次 | 样本数 |
|------------|-----------|-----------|---------|--------|
| {agent1}   | {ttfr1}   | {total1}  | {rounds1} | {n1} |
| {agent2}   | {ttfr2}   | {total2}  | {rounds2} | {n2} |

#### 任务完成度

| Agent/模型 | 完成率 | 一次性完成率 | 平均修正次数 | 样本数 |
|------------|--------|-------------|-------------|--------|
| {agent1}   | {rate1} | {first1}    | {fix1}      | {n1} |
| {agent2}   | {rate2} | {first2}    | {fix2}      | {n2} |

#### 用户满意度

| Agent/模型 | 正向反馈 | 负向反馈 | 重复提问 | 净满意度 |
|------------|---------|---------|---------|---------|
| {agent1}   | {pos1}  | {neg1}  | {rep1}  | {score1} |
| {agent2}   | {pos2}  | {neg2}  | {rep2}  | {score2} |

#### 工具使用效率

| Agent/模型 | 平均调用次数 | 平均工具种类 | 错误重试次数 | 样本数 |
|------------|-------------|-------------|-------------|--------|
| {agent1}   | {calls1}    | {types1}    | {retry1}    | {n1} |
| {agent2}   | {calls2}    | {types2}    | {retry2}    | {n2} |

#### 错误率

| Agent/模型 | 任务失败 | 超时 | 异常 | 总错误率 | 样本数 |
|------------|---------|------|------|---------|--------|
| {agent1}   | {fail1} | {to1} | {err1} | {rate1} | {n1} |
| {agent2}   | {fail2} | {to2} | {err2} | {rate2} | {n2} |

---

### 🎯 综合评估

#### 优势领域

| Agent/模型 | 最强领域 | 关键指标 |
|------------|---------|---------|
| {agent1}   | {area1} | {metric1} |
| {agent2}   | {area2} | {metric2} |

#### 需要改进

| Agent/模型 | 薄弱领域 | 关键指标 | 建议 |
|------------|---------|---------|------|
| {agent1}   | {area1} | {metric1} | {suggestion1} |
| {agent2}   | {area2} | {metric2} | {suggestion2} |

---

### 🌟 独特特性分析

> 以下特性无法通过量化指标直接比较，但基于真实交互观察得出。

#### {Agent/模型 1}
- **特点描述**: {qualitative observation}
- **典型场景**: {example scenario}
- **用户评价**: {user feedback quote if available}

#### {Agent/模型 2}
- **特点描述**: {qualitative observation}
- **典型场景**: {example scenario}
- **用户评价**: {user feedback quote if available}

---

### 📋 建议与洞察

1. **模型选择建议**: {基于数据的推荐}
2. **场景适配建议**: {哪些场景适合哪种框架/模型}
3. **本周亮点**: {值得关注的积极变化}
4. **需关注项**: {需要关注的问题}

---

### ⚠️ 数据说明

- 本报告基于聊天记录的 AI 分析，数据可能存在偏差
- 样本量不足时（< 5 次），结论仅供参考
- 独特特性分析为主观观察，建议结合实际使用体验判断
```

### 6. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId：

```
send_user_feedback({
  content: [报告内容],
  format: "text",
  chatId: [配置的 chatId]
})
```

### 7. 保存历史数据

将分析结果追加到 `workspace/data/framework-race-history.json`：

```json
{
  "history": [
    {
      "date": "2026-03-24T09:00:00.000Z",
      "period": "2026-03-17 to 2026-03-24",
      "chatsAnalyzed": 15,
      "messagesAnalyzed": 420,
      "agents": {
        "claude-sonnet-4": {
          "avgTTFR": "5.2s",
          "completionRate": 0.85,
          "userSatisfaction": 0.78
        },
        "claude-opus-4": {
          "avgTTFR": "8.1s",
          "completionRate": 0.92,
          "userSatisfaction": 0.88
        }
      },
      "topRecommendation": "对于复杂任务推荐使用 opus，简单任务使用 sonnet 以节省成本"
    }
  ]
}
```

---

## 错误处理

1. 如果日志文件读取失败，跳过该文件继续处理其他文件
2. 如果 `send_user_feedback` 失败，记录日志并重试一次
3. 如果过去 7 天没有聊天记录，发送简要通知："本周无聊天记录，跳过分析"
4. 如果某个 Agent/模型的样本量 < 5，在报告中标注"样本不足，仅供参考"
5. 如果无法识别 Agent/模型信息，按"未分类"分组，并在报告中提示

## 注意事项

1. **零代码侵入**: 本 schedule 不修改任何核心代码，仅分析已有的聊天记录
2. **AI 驱动分析**: 由 Agent 自主解读聊天记录，不使用硬编码的排名算法
3. **独特特性**: 不要忽略各框架的独特特性，这是量化指标无法反映的价值
4. **隐私保护**: 报告中不包含具体的聊天内容，仅包含统计和分析结论
5. **增量分析**: 历史数据保存在 `workspace/data/framework-race-history.json`，可用于趋势分析

## 关联

- **Issue**: #1334
- **参考实现**: `daily-chat-review` skill
- **数据来源**: `workspace/logs/` 聊天记录

---
name: "自我体验 (Dogfooding)"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
createdAt: "2026-05-05T00:00:00.000Z"
---

# 自我体验 (Dogfooding)

每周一 10:00 自动进行功能自我体验，从新用户视角探索系统功能，生成反馈报告。

**关联 Issue**: #1560
**Milestone**: 0.4.0 自我体验

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 1. 发现可用功能

扫描系统中所有可用的 Skill 和功能：

```bash
ls skills/*/SKILL.md
```

对每个 Skill，读取其 SKILL.md 了解功能描述、触发关键词和工具需求。

### 2. 设计探索计划

根据发现的功能，设计 3-5 个不同类别的探索场景：

| 类别 | 探索重点 |
|------|----------|
| 基础交互 | 聊天质量、响应准确性 |
| Skill 调用 | 发现性、触发准确性 |
| 边界情况 | 错误处理、优雅降级 |
| 集成场景 | 跨功能工作流 |
| 帮助与文档 | 新手引导、自描述能力 |

### 3. 执行探索场景

对每个场景，模拟新用户的自然交互：
- 以新手视角思考"用户会怎么说"
- 追踪系统的预期行为
- 记录实际体验和发现的问题
- 为每个场景打 UX 分数 (1-5)

### 4. 交叉验证

检查最近的 GitHub Issues，对比探索发现与真实用户反馈：

```bash
gh issue list --repo hs3180/disclaude --state closed --limit 10 --json title,labels
gh issue list --repo hs3180/disclaude --state open --limit 10 --json title,labels
```

### 5. 生成报告

按 self-experience Skill 中定义的格式生成结构化反馈报告，包含：
- 总体评估（5 维度评分）
- 亮点（做得好的地方）
- 问题发现（带严重程度和复现步骤）
- 改进建议（带优先级）
- 探索场景详情
- 建议的下一步

### 6. 发送报告

使用 `send_user_feedback` 将报告发送到配置的 chatId：

```
send_user_feedback({
  content: [报告内容],
  format: "text",
  chatId: [配置的 chatId]
})
```

## 验收标准 (来自 Issue #1560)

- [x] 能以新用户视角探索功能 (通过 prompt-based LLM 分析)
- [x] 能进行不预设场景的模拟活动 (通过多样化探索计划)
- [x] 能生成结构化反馈报告 (通过报告模板)
- [x] 能定时触发 (通过 scheduler)
- [ ] 能自动提交 Issue (Phase 2，需要用户确认)

## 关联

- **核心功能**: #1560 (自我体验/Dogfooding)
- **相关 Skill**: daily-chat-review (聊天分析), feedback (反馈收集)
- **类型**: MVP 用例

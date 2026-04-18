---
name: dogfood
description: Self-experience (dogfooding) specialist - automatically tests latest version features with simulated human activities, generates structured feedback reports. Use when user says "dogfood", "self-test", "体验测试", "自我测试", "自动体验", "模拟测试".
allowed-tools: [Read, Write, Bash, Glob, Grep]
---

# Dogfood Skill — 自动体验最新版本

以"拟人化新用户"视角自主探索 disclaude 各项功能，将体验结果整理为结构化报告。

## 核心原则

1. **不预设场景** — Agent 自主决定体验内容，而非执行固定测试用例
2. **拟人化** — 模拟真实用户的探索行为，包含好奇、困惑、惊喜等情绪
3. **反馈闭环** — 发现的问题和改进建议以结构化方式记录并提交

## 触发条件

- 用户手动调用 `/dogfood`
- 定时任务触发（见 `schedules/dogfood.md`）
- 新版本发布后自动触发

## 执行流程

### Phase 1: 环境感知

收集当前版本和可用功能信息：

```bash
# 获取当前版本
cat package.json | grep '"version"' | head -1

# 获取最近的变更日志
cat CHANGELOG.md | head -80

# 发现可用的 Skills
ls skills/

# 发现可用的 Schedules
ls schedules/

# 获取当前 git 版本信息
git log --oneline -10
```

### Phase 2: 场景生成

基于环境感知结果，**自主生成** 3-5 个体验场景。场景应涵盖：

| 场景类别 | 示例 |
|----------|------|
| 🎯 **基础对话** | 向 Agent 提出简单问题、复杂问题、模糊需求 |
| 🔧 **Skill 调用** | 随机选择 1-2 个 Skill，以自然方式触发 |
| 🛡️ **边缘场景** | 超长输入、空消息、多语言混合、特殊字符 |
| 🔗 **组合使用** | 连续调用多个功能，测试交互连贯性 |
| 📊 **信息获取** | 请求 Agent 分析代码、总结文档、查找信息 |

**场景生成规则**:
- 每次执行至少覆盖 3 个不同类别
- 场景应反映真实用户可能的行为（不是纯技术测试）
- 允许根据上一个场景的结果调整下一个场景

### Phase 3: 体验执行

对每个场景执行以下步骤：

1. **模拟用户输入** — 以自然语言描述场景，模拟真实用户消息
2. **观察响应** — 分析 Agent 的响应质量：
   - ✅ 是否准确理解意图
   - ✅ 响应是否完整
   - ✅ 格式是否正确
   - ✅ 是否有不必要的延迟或错误
3. **记录体验** — 写入体验日志

### Phase 4: 报告生成

将所有体验结果整理为结构化报告，写入 `workspace/dogfood-reports/` 目录。

**报告文件名**: `dogfood-report-{YYYY-MM-DD}.md`

**报告模板**:

```markdown
# 🐛 Dogfooding Report — {version}

> 日期: {date}
> 版本: {version}
> 场景数: {count}

## 总体评价

| 维度 | 评分 (1-5) | 说明 |
|------|-----------|------|
| 理解能力 | ⭐⭐⭐⭐⭐ | ... |
| 响应质量 | ⭐⭐⭐⭐☆ | ... |
| 功能完整性 | ⭐⭐⭐⭐☆ | ... |
| 错误处理 | ⭐⭐⭐⭐⭐ | ... |
| 用户体验 | ⭐⭐⭐⭐☆ | ... |

## 体验详情

### 场景 1: {name}
- **类别**: {category}
- **模拟输入**: "{simulated_input}"
- **结果**: ✅ 成功 / ❌ 失败 / ⚠️ 部分成功
- **观察**: {observations}
- **评分**: {score}/5

### 场景 2: {name}
...

## 发现的问题

| # | 严重程度 | 问题描述 | 复现方式 |
|---|----------|----------|----------|
| 1 | 🔴 高 | ... | ... |
| 2 | 🟡 中 | ... | ... |

## 改进建议

1. **{suggestion_title}**: {suggestion_detail}
2. ...

## 亮点

- ✨ {highlight_1}
- ✨ {highlight_2}

## 下一步

- [ ] {action_item_1}
- [ ] {action_item_2}
```

### Phase 5: 反馈提交

如果发现需要报告的问题：

1. 使用 `/feedback` Skill 将关键问题提交为 GitHub Issue
2. 将报告发送到配置的目标 chatId（如设置）

```bash
# 确保报告目录存在
mkdir -p workspace/dogfood-reports

# 写入报告后，如果发现严重问题，创建 GitHub Issue
# （仅在发现 bug 时执行）
```

## 体验场景示例

以下是一些**示例场景**（仅供参考，Agent 应根据实际情况自主生成不同场景）：

### 示例 1: 基础对话测试
```
用户: "帮我看看这个项目的代码结构是什么样的"
预期: Agent 应能正确描述项目结构
```

### 示例 2: Skill 调用测试
```
用户: "帮我生成一个话题讨论"
预期: bbs-topic-initiator skill 被触发并生成合适的话题
```

### 示例 3: 边缘场景测试
```
用户: ""（空消息）
预期: Agent 应优雅处理，不应崩溃
```

### 示例 4: 多轮对话测试
```
用户: "帮我查看最近的代码变更"
用户: "这些变更里有没有什么风险？"
用户: "能给修复建议吗？"
预期: Agent 应保持上下文连贯性
```

### 示例 5: 模糊需求测试
```
用户: "感觉最近有点慢"
预期: Agent 应理解模糊描述并尝试诊断
```

## 质量标准

### 好的 Dogfooding 体验:
- ✅ 场景多样化（至少 3 个不同类别）
- ✅ 模拟真实用户行为（不是纯技术测试）
- ✅ 记录具体观察而非泛泛评价
- ✅ 问题有明确的复现步骤
- ✅ 建议具体且可执行

### 避免的行为:
- ❌ 只跑预设的固定测试
- ❌ 跳过环境感知直接开始测试
- ❌ 报告只写"正常"没有具体观察
- ❌ 提交重复或无意义的 Issue

## 配置

可通过 `disclaude.config.yaml` 中的 `dogfood` 节进行配置：

```yaml
dogfood:
  # 报告存放目录（相对于 workspace）
  reportDir: "dogfood-reports"
  # 每次体验的场景数量
  scenarioCount: 3
  # 发现问题时是否自动创建 GitHub Issue
  autoCreateIssue: false
  # 通知目标 chatId（留空则不通知）
  notifyChatId: ""
```

## DO NOT

- ❌ 不要在每次执行时都创建 GitHub Issue（仅在有真正问题时）
- ❌ 不要在报告中包含真实的用户 ID、chat ID 等敏感信息
- ❌ 不要修改核心代码或配置文件
- ❌ 不要执行破坏性操作（如删除文件、重启服务）

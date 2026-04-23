---
name: "Dogfooding"
cron: "0 10 * * 1-5"
enabled: false
blocking: true
chatId: "oc_your_developer_group_id"
createdAt: "2026-04-23T00:00:00.000Z"
---

# Dogfooding (自我体验)

工作日每天 10:00 自动执行自我体验：检测版本变更，触发 disclaude 以新用户视角体验自身功能，生成结构化反馈报告。

## 配置

- **执行时间**: 工作日每天 10:00 (UTC)
- **报告目录**: `workspace/dogfood/`
- **状态文件**: `workspace/dogfood/state.json`
- **最大场景数**: 5（每次体验最多执行的场景数）
- **每个场景超时**: 60 秒

## 职责边界

- ✅ 检测版本变更（通过 package.json 和 state.json）
- ✅ 调用 self-experience skill 执行体验
- ✅ 发送体验报告到开发者群组
- ❌ 不修改源代码
- ❌ 不创建新的 Schedule
- ❌ 不执行破坏性操作

## 执行步骤

### Step 1: 版本变更检测

读取当前版本和上次体验版本：

```bash
# 当前版本
CURRENT_VERSION=$(node -e "console.log(require('./package.json').version)")

# 上次体验版本
LAST_VERSION=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('workspace/dogfood/state.json','utf-8')).lastVersion) } catch { console.log('') }" 2>/dev/null)
```

**判断逻辑**：
- 如果 `CURRENT_VERSION != LAST_VERSION` → 标记为 **版本变更**，优先测试新功能
- 如果版本相同 → 正常体验，但可以使用不同场景

### Step 2: 读取最近变更

如果检测到版本变更，读取 CHANGELOG 了解新功能：

```bash
head -50 CHANGELOG.md
```

将 CHANGELOG 内容传递给 self-experience skill，以便它优先测试新功能。

### Step 3: 执行自我体验

调用 `self-experience` skill 执行自我体验：

```
使用 self-experience skill 执行自我体验。

当前版本: {CURRENT_VERSION}
上次体验版本: {LAST_VERSION}
版本变更: {是/否}

{如果版本变更，附上 CHANGELOG 内容}
```

### Step 4: 发送报告摘要

体验完成后，读取生成的报告并发送摘要到开发者群组：

```bash
# 读取最新报告
LATEST_REPORT=$(ls -t workspace/dogfood/*.md 2>/dev/null | head -1)

# 读取状态
STATE=$(cat workspace/dogfood/state.json 2>/dev/null)
```

发送报告摘要到 chatId：

```
send_user_feedback({
  chatId: "{chatId}",
  message: "🐕 自我体验报告\n\n版本: {CURRENT_VERSION}\n评分: {score}/5\n场景数: {count}\n\n[摘要...]\n\n完整报告: workspace/dogfood/{date}.md"
})
```

## 状态追踪

`workspace/dogfood/state.json` 格式：

```json
{
  "lastVersion": "0.5.0",
  "lastRun": "2026-04-23T10:00:00Z",
  "lastScore": 4,
  "totalRuns": 5,
  "averageScore": 3.8
}
```

## 评分参考

| 评分 | 含义 |
|------|------|
| 5 | 所有场景表现优秀，无问题 |
| 4 | 大部分场景表现良好，有小问题 |
| 3 | 基本功能正常，有明显改进空间 |
| 2 | 多个场景出现问题 |
| 1 | 严重问题，影响基本使用 |

## 错误处理

| 场景 | 处理方式 |
|------|----------|
| `disclaude --prompt` 执行失败 | 记录错误，跳过该场景，继续其他场景 |
| 报告生成失败 | 发送简短错误通知到群组 |
| state.json 损坏 | 重建 state.json，从头开始 |
| workspace/dogfood/ 不存在 | 自动创建目录 |

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的开发者群组 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整时间（默认工作日 10:00 UTC）

## 验收标准

- [ ] 能检测版本变更
- [ ] 能调用 self-experience skill 执行体验
- [ ] 体验报告保存到 workspace/dogfood/
- [ ] 状态文件正确更新
- [ ] 报告摘要发送到开发者群组
- [ ] 版本未变更时仍能正常执行
- [ ] 错误场景不影响后续执行

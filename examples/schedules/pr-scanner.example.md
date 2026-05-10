---
name: "PR Scanner"
cron: "0 */30 * * * *"
enabled: false
blocking: true
modelTier: "low"
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
---

# PR Scanner — 定时扫描与自动审查

定期扫描仓库的 open PR，为新 PR 创建审查群、执行自动 review、发送审查卡片。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每 30 分钟
- **通知目标**: 配置的 chatId（控制频道）+ 每个 PR 独立审查群

## 执行步骤

### 1. 获取当前 open PR 列表

```bash
gh pr list --repo hs3180/disclaude --state open --json number,title,author,updatedAt,mergeable,statusCheckRollup
```

### 2. 读取映射表

读取 `workspace/bot-chat-mapping.json`，提取 `purpose: 'pr-review'` 条目。

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

### 3. 识别新 PR

对比映射表，找出映射表中不存在的 PR（即新 PR）。

### 4. 处理每个新 PR

对于每个新 PR（并发上限内，默认 3 个）：

#### 4a. 创建审查群

```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群"
```

#### 4b. 写入映射表

追加 `pr-{number}` 条目到 `workspace/bot-chat-mapping.json`。

#### 4c. 获取 PR 详细信息

```bash
gh pr view {number} --repo hs3180/disclaude --json title,body,author,headRefName,baseRefName,mergeable,additions,deletions,changedFiles,labels
```

#### 4d. 获取 PR Diff

```bash
gh pr diff {number} --repo hs3180/disclaude
```

#### 4e. 执行自动 Review

基于 PR 信息和 diff，生成结构化 review：
- **变更概要**: 修改文件和规模
- **关键改动**: 核心逻辑变更、新增/删除功能
- **潜在问题**: bug、安全隐患、性能问题
- **测试覆盖**: 测试是否充分
- **Review 分级**: ✅ Approve / ⚠️ Request Changes / 💬 Comment

#### 4f. 发送 Review 卡片

向审查群发送 review 卡片（使用 `send_card` 或 `send_interactive` MCP 工具）。

卡片包含：
- PR 信息（标题、作者、分支、变更统计）
- Review 结果（分级 + 详细分析）
- 链接到 GitHub PR 页面

#### 4g. 向控制频道汇报

向配置的 chatId 发送简要通知。

### 5. 检查已有群的 PR 状态

```bash
gh pr list --repo hs3180/disclaude --state closed --json number,state
```

对已 merged/closed 的 PR 记录日志，不自动解散群。

## Review 卡片模板

```
## PR #{number}: {title}

👤 {author} · 🌿 {headRef} → {baseRef}
📊 +{additions} -{deletions} ({changedFiles} files)

### Review: {分级}

**变更概要**: {summary}
**关键改动**: {keyChanges}
**潜在问题**: {potentialIssues}
**建议**: {suggestions}

🔗 https://github.com/hs3180/disclaude/pull/{number}
```

## 错误处理

- 如果 `gh` 命令失败，记录错误并发送错误通知到 chatId
- 如果映射文件损坏，视为空表（全量扫描）
- 如果群创建失败，跳过该 PR
- 如果 diff 过大（>3000行），降级为文件列表 + stat review
- 如果卡片发送失败，记录错误但继续处理其他 PR

## 使用说明

1. 复制此文件到 `workspace/schedules/pr-scanner.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID（用于接收控制通知）
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 实现状态

| Phase | 功能 | 状态 |
|-------|------|------|
| Phase 1 | 基本扫描 + 通知 | ✅ 可用 |
| Phase 2 | 为每个 PR 创建群聊 | ✅ 可用（lark-cli） |
| Phase 3 | 自动 Review + 卡片 | ✅ 可用 |
| Phase 4 | 交互式操作按钮 | ⏳ 未来计划 |

详见: `docs/designs/pr-scanner-design.md`

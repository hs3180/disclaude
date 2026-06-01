---
name: pr-scanner
description: PR Scanner - scans a GitHub repository for open PRs, creates discussion groups for new PRs, and tracks PR-to-chatId mappings. Triggered by schedule or manual invocation. Keywords: "PR Scanner", "扫描 PR", "scan pull requests", "PR review".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# PR Scanner — 映射表驱动扫描

扫描仓库的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建群并写入映射。

**适用于**: 扫描 PR、创建讨论群、追踪映射 ｜ **不适用于**: 发卡片、解散群、merge/close PR

## Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `{repo}` | Yes | — | GitHub repo (owner/name) |
| `{controlChannelChatId}` | Yes | — | Schedule execution context chatId |
| `{maxConcurrent}` | No | `3` | Max concurrent PR reviews |
| `{inviteUsers}` | No | — | comma-separated user open_ids to invite when creating PR discussion groups |

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `pr-{number}` → `purposeFromKey()` 推断 purpose
- **群名**: `PR #{number} · {title前30字}` → `parseGroupNameToKey()` 解析 key

## 执行步骤

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目的 PR number 和 chatId。文件不存在则视为空映射表。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo {repo} --state open --json number,title,author,headRefName
```

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

```bash
gh pr list --repo {repo} --state closed --json number,state
```

merged/closed → 记录日志，不自动解散。open → 跳过。

### 5. 新 PR — 创建讨论群

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过。

对每个新 PR（按 number 升序）：

**5a. 创建群**:
```bash
lark-cli im chat create --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群" {--users inviteUsers}
```

如果 `{inviteUsers}` 参数非空，则追加 `--users {inviteUsers}` 以邀请指定用户。

**5b. 写入映射**: 追加 `pr-{number}` 条目（chatId, createdAt, purpose: "pr-review"），原子写入。

**5c. 注入 Review Agent 指令**: 使用 `push_to_agent` 向新建群聊的 chatId 注入 PR review 指令，指导 Agent 进行深度代码审查。

> **变量替换**: 以下模板中的 `{number}`、`{repo}`、`{headRefName}` 由 PR Scanner 在调用 `push_to_agent` 时从步骤 2 的 PR 列表数据中替换。`{新群chatId}` 为步骤 5a 返回的群 ID。

```
使用 push_to_agent 向 chatId={新群chatId} 推送以下指令：

你是一个 PR Review Agent。请对 PR #{number}（{repo}）进行深度代码审查。

步骤：
1. 获取 PR 概览：gh pr view {number} --repo {repo} --json title,body,author,additions,deletions,changedFiles
2. 克隆仓库到临时目录：
   TMPDIR=$(mktemp -d) && cd $TMPDIR
   gh repo clone {repo} . -- --depth=50
   git fetch origin {headRefName} && git checkout -b review FETCH_HEAD
3. 查看 diff：gh pr diff {number} --repo {repo}
4. 结合完整代码上下文审查：阅读被修改文件及其依赖、调用链、测试文件
5. 在讨论群中发表结构化审查意见（关键问题 / 建议 / 样式）
6. 清理：rm -rf $TMPDIR

如果步骤 2 克隆/checkout 失败，回退到仅使用 diff 审查（跳过步骤 2 和 4），并在审查结论中标注「⚠️ 基于diff审查（仓库克隆失败）」。

审查重点：
- 修改是否与现有代码风格/模式一致
- 是否破坏了其他模块的隐式依赖
- 测试是否充分覆盖了边界条件
- 类型推断、import 路径等需要完整代码才能验证的问题
```

## 错误处理

- `gh` 命令失败 → 记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR
- `push_to_agent` 失败 → 记录错误并报告到控制频道；群已创建但 Agent 未初始化（用户可手动在群中触发）
- Review Agent 克隆/checkout 失败 → 由注入指令中的回退逻辑处理，降级为 diff-only 审查

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **用户驱动解散** — Bot 不自主解散群
3. **幂等操作** — 映射表过滤防重复创建
4. **无 Label 依赖** — 状态全在映射表

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

## Schedule 模板

见同目录下的 `schedule.md`。将其复制到 `schedules/pr-scanner/SCHEDULE.md`，替换 `{controlChannelChatId}`、`{repo}` 和 `{inviteUsers}` 后启用。

## 关联

- Parent: #2945
- Depends on: #2947 (BotChatMappingStore), #2946 (移除 register_temp_chat)

---
name: "PR Scanner"
cron: "{cron}"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

扫描仓库 `{repo}` 的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建群并写入映射。

**适用于**: 扫描 PR、创建讨论群、追踪映射 ｜ **不适用于**: 发卡片、解散群、merge/close PR

## 参数

- **仓库**: `{repo}`
- **并发上限**: {maxConcurrent}
- **邀请用户**: `{inviteUsers}`（可选，逗号分隔的飞书 open_id，创建讨论群时自动邀请）

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

merged/closed → 记录日志。如该群的 agent 会话已结束（映射表中有条目但群内无 agent 活动），scanner 主动调用 dissolve-group 清理，防止孤儿群。open → 跳过。

### 5. 新 PR — 创建讨论群

并发检查：映射表中 `purpose: 'pr-review'` 条目数 ≥ `{maxConcurrent}` 则跳过。

对每个新 PR（按 number 升序）：

**5a. 拉取 PR 分支到临时目录**:
```bash
WORKDIR=$(mktemp -d /tmp/pr-{number}-XXXXXX)
gh repo clone {repo} "$WORKDIR" -- --depth=50
cd "$WORKDIR"
git fetch origin pull/{number}/head:pr-{number}
git checkout pr-{number}
```
此目录提供完整代码上下文，供 agent 阅读、review、修改和运行测试。`gh repo clone` 使用 GitHub CLI 认证，支持私有仓库。

**5b. 创建群**:
```bash
lark-cli im +chat-create --as bot --name "PR #{number} · {title前30字}" --description "PR #{number} 审查讨论群" {inviteUsersFlag}
```

如果 `{inviteUsers}` 非空，则 `{inviteUsersFlag}` 替换为 `--users {inviteUsers}`；否则替换为空字符串。

**5c. 写入映射**: 追加 `pr-{number}` 条目（chatId, createdAt, purpose: "pr-review", workdir: "$WORKDIR"），原子写入。

**5d. 推送 review 指令到新群**: 使用 `push_to_agent` 向新群发送 review 指令，告知 agent 工作目录为 `$WORKDIR`，可在此目录中进行代码阅读、review、修改和测试。指令内容应包含以下 prompt 模板：

```
你是 PR #{number} 的审查员。

**工作目录**: {workdir}
**PR 链接**: https://github.com/{repo}/pull/{number}

请阅读 PR 代码，完成审查并给出反馈。

## PR 关闭后清理

**每次收到用户消息时**，先检查 PR 状态（`gh pr view {number} --repo {repo} --json state,mergedAt`）。当 PR 已合并或关闭时：
1. 在群中发送审查总结和感谢消息
2. 使用 Skill 工具调用 dissolve-group 解散本群并释放名额：
   Skill: dissolve-group，参数: DISSOLVE_KEY=pr-{number}
   如 Skill 不可用，回退到 Bash 执行：
   `cd {workspace_root} && DISSOLVE_KEY=pr-{number} npx tsx skills/dissolve-group/dissolve-group.ts`
```

### 6. 清理临时目录

dissolve-group 执行时会自动清理 workdir（见 step 5d）。此处仅作为兜底：当 dissolve-group 未成功执行时，由 scanner 手动清理：

```bash
# 兜底：从映射表读取 workdir 字段（正常情况下 dissolve-group 已清理）
rm -rf "{workdir}"
```

## 错误处理

- `gh` 命令失败 → 记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR，清理临时目录
- PR 分支拉取失败 → 跳过该 PR

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **Agent 驱动解散** — review agent 在 PR 关闭后调用 dissolve-group 解散群（#3972）
3. **幂等操作** — 映射表过滤防重复创建
4. **无 Label 依赖** — 状态全在映射表
5. **临时目录隔离** — 每个 PR 独立目录，互不干扰，PR 关闭时清理

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）

---
name: "PR Scanner"
cron: "{cron}"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

扫描仓库 `{repo}` 的 open PR，通过映射表追踪已创建的讨论群，为新 PR 创建群并写入映射。

**适用于**: 扫描 PR、创建讨论群、追踪映射、超时群自动解散 ｜ **不适用于**: 发卡片、merge/close PR

## 参数

- **仓库**: `{repo}`
- **并发上限**: {maxConcurrent}
- **邀请用户**: `{inviteUsers}`（可选，逗号分隔的飞书 open_id，创建讨论群时自动邀请）

## 数据结构

映射文件: `workspace/bot-chat-mapping.json`（BotChatMappingStore）

- **Key**: `pr-{number}` → `purposeFromKey()` 推断 purpose
- **群名**: `PR #{number} · {title前30字}` → `parseGroupNameToKey()` 解析 key

## 执行步骤

### 0. 确保 GitHub token 有效（Issue #4237）

PR Scanner 在长寿命会话中执行，会话环境变量 `GH_TOKEN` 在 spawn 时冻结、不会自动刷新，而 GitHub Installation Access Token **每小时过期一次**。token 失效时 `gh` 返回 **401 Bad credentials** 且输出为空，scanner 会把空结果当成「0 open PR」从而**静默漏掉新 PR、不建审查群**。因此每轮扫描前先确认 token 有效：

```bash
# GH_TOKEN 每小时过期；过期后 gh 返回 401、输出为空，scanner 会误判「0 open PR」
# 注意：EXP 取自 .runtime-env，可能与会话内冻结的 GH_TOKEN 不同步——.runtime-env 陈旧时
# 触发一次冗余刷新即自愈（无害）；会话 token 比 .runtime-env 更旧的情形由下方 401 重试兜底。
EXP=$(grep '^GH_TOKEN_EXPIRES_AT=' {workspace_root}/.runtime-env 2>/dev/null | head -1 | sed 's/^GH_TOKEN_EXPIRES_AT=//' | tr -d '"')
NOW=$(date -u +%s)
EXP_TS=$(date -u -d "$EXP" +%s 2>/dev/null || echo 0)
if [ -z "$EXP" ] || [ "$NOW" -ge "$EXP_TS" ]; then
  echo "GH_TOKEN missing or expired — refresh via github-jwt-auth skill"
fi
```

- 若上述判定为「需刷新」：调用 **`github-jwt-auth`** skill（用 GitHub App JWT 签名换取新的 Installation Access Token，写入 `{workspace_root}/.runtime-env` 的 `GH_TOKEN` / `GH_TOKEN_EXPIRES_AT`），随后 `set -a; source {workspace_root}/.runtime-env; set +a` 再继续（`set -a` 确保写入的 KEY=VALUE 被 export 给后续 `gh` 子进程）。刷新、`source` 与后续 `gh` 必须在**同一次 Bash 调用内**完成——harness 每次 Bash 调用是全新 shell，sourced 的环境变量不跨调用持久化；分两次调用会让 `gh` 仍读到 spawn 时冻结的旧 token（Nit A，#4266 review）。
- 即便 preflight 通过，后续任一 `gh` 命令若返回 **401 Bad credentials**，同样先调用 `github-jwt-auth` 刷新并重试该命令；仍失败才按「错误处理」记录并跳过。

### 1. 读取映射表

```bash
cat workspace/bot-chat-mapping.json 2>/dev/null || echo "{}"
```

提取所有 `purpose: 'pr-review'` 条目的 PR number 和 chatId。文件不存在则视为空映射表。

### 2. 获取 Open PR 列表

```bash
gh pr list --repo {repo} --state open --json number,title,author,headRefName
```

> ⚠️ **务必检查 `gh` 退出码**：退出码非 0、或输出异常为空时，**不得**当作「0 open PR」继续到步骤 3 —— 应按「步骤 0」刷新 token 后在**同一次 Bash 调用内**重试；仍失败则记为错误并退出本轮扫描。空结果只有伴随退出码 0 才算真空 PR（Issue #4237：token 过期的空结果曾被误当「0 open PR」而漏建群）。

### 3. 过滤与分类

将获取到的 PR 分为两类：

- **新 PR**：PR number 不在映射表中（`pr-{number}` key 不存在）
- **已有群的 PR**：PR number 在映射表中存在

### 4. 已有群的 PR — 状态变更检测

```bash
gh pr list --repo {repo} --state closed --json number,state
```

merged/closed → 记录日志。如该群的 agent 会话已结束（映射表中有条目但群内无 agent 活动），scanner 主动调用 dissolve-group 清理，防止孤儿群。open → 跳过。

### 4b. 已有群的 PR — 不活跃提醒与递进升级（Issue #3966）

对映射表中所有 `purpose: 'pr-review'` 且未在步骤 4 中被标记为 closed/merged 的群，检查活跃度：

```bash
lark-cli api GET "/open-apis/im/v1/messages" --as bot --query container_id_type=chat "container_id={chatId}" "page_size=1" "sort_type=ByCreateTimeDesc"
```

从返回的最后一条消息的 `create_time` 计算时间差。使用映射表中的 `lastReminderAt` 和 `reminderCount` 字段控制提醒频率和升级：

| 条件 | 动作 |
|------|------|
| **超过 2h 无消息** 且 `reminderCount` 为 0 或空 | 发送普通卡片提醒，`reminderCount` → 1，记录 `lastReminderAt` |
| **超过 2.5h 无消息** 且 `reminderCount` = 1 且距上次提醒 > 30min | 发送 **@用户** 提醒，`reminderCount` → 2，更新 `lastReminderAt` |
| **超过 3h 无消息** 且 `reminderCount` = 2 且距上次提醒 > 30min | 发送 **飞书加急消息**（urgent），`reminderCount` → 3，更新 `lastReminderAt` |
| **超过 4h 无消息** 且 `reminderCount` ≥ 3（多次提醒超时） | **scanner 自动解散该群**（步骤 4c），释放名额给排队 PR |

提醒消息模板：

- **第 1 次**（普通卡片）：`这条 review 群已经超过 2 小时没有新消息。如果 review 已完成，可以回复 /dissolve 解散群释放名额。如果需要继续，请忽略此提醒。`
- **第 2 次**（@用户）：`@用户 这条 review 群已经超过 2.5 小时没有新消息，请确认 review 状态。如已完成请回复 /dissolve。`
- **第 3 次**（加急）：使用飞书 urgent 消息发送 `⚠️ PR review 群已超过 3 小时无活动，请尽快处理或解散群。`

每次发送提醒后，使用 `store.update(key, { lastReminderAt, reminderCount })` 原子更新映射表中该条目。

**活跃度恢复重置**: 如果群内有新消息（`create_time` 在 2h 以内），且 `reminderCount` > 0，则调用 `store.update(key, { reminderCount: 0 })` 重置计数器，跳过提醒。

### 4c. 超时自动解散与冷却抑制（多次提醒超时）

对 `reminderCount` ≥ 3 且**超过 4h 无任何用户消息**的群（"多次提醒超时"），scanner **主动解散**，防止单个 PR 长期占住名额、阻塞排队 PR：

1. **解散前**在群内发总结消息：「⏰ 本 review 群已达最高提醒级别（加急）且持续 >4h 无响应，scanner 自动解散以释放名额。PR 仍 open，将在冷却后（默认 24h）由 scanner 重新排队建群。」
2. **调用 dissolve-group** 解散（清理群 + workdir + 映射条目）：`DISSOLVE_KEY=pr-{number}`；如 Skill 不可用，回退到 Bash：`cd {workspace_root} && DISSOLVE_KEY=pr-{number} npx tsx skills/dissolve-group/dissolve-group.ts`（同「PR 关闭后清理」）。
3. **冷却抑制**：解散后向映射表写入抑制条目 `pr-{number}`：`{purpose: "pr-review-suppressed", suppressedAt: <now>, suppressedUntil: <now+24h>, reason: "timeout-4h"}`。该条目使步骤 3 视该 PR 为「已有群」（不重复建群）、且不计入步骤 5 的并发名额（`purpose != "pr-review"`）。
4. **冷却到期**：每次扫描检查所有 `purpose: "pr-review-suppressed"` 条目，若 `suppressedUntil` 已过则删除条目 —— 该 PR 重新变为「新 PR」，可被步骤 5 重新建群。

**说明**：仅当 PR 仍 open 且 `reminderCount` ≥ 3 且 >4h 无用户消息才解散；若期间有用户消息则按「活跃度恢复重置」归零计数器，**不解散**。

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

## 🔧 权限边界：可改本 PR、经授权可合并

- ✅ 允许（无需额外授权）：阅读/review；**push 更新本 PR head 分支**落地商定的修复/nit/补丁（仅限本 PR head 分支）。
- ✅ 允许合并——**仅当用户在本群明确说「合并」/点合并按钮后**，先重核 CI 全绿 + `gh pr mergeable`，再 `gh pr merge --squash`。
- ❌ 仍禁：未经明确同意合并、`gh pr close/ready/review --approve`、建 follow-up PR 再合、push 到 main/强推/删分支、改 label/设置等。
- **合并必须等用户在该群明确指令**——这条不变（源于 #4239 unauthorized merge 历史事故教训，CI 全绿 ≠ 授权合并）。

发现 PR 有问题 → 在评论里说明即可；PR 已被人类合并/关闭 → 按下方"PR 关闭后清理"解散本群。

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

- `gh` 命令失败 → 若返回 401 Bad credentials（token 过期），先调用 `github-jwt-auth` skill 刷新 `GH_TOKEN` 并 `set -a; source {workspace_root}/.runtime-env; set +a` 后重试；仍失败才记录错误，跳过/退出
- 映射文件读取失败 → 视为空表
- 映射文件写入失败 → 记录错误（可通过群名重建）
- 群创建失败 → 跳过该 PR，清理临时目录
- PR 分支拉取失败 → 跳过该 PR

## 设计原则

1. **映射表是缓存** — 可从飞书 API 重建
2. **解散触发** — review agent 在 PR 合并/关闭后解散（#3972）；scanner 对「多次提醒超时」（`reminderCount` ≥ 3 且 >4h 无用户响应）的群自动解散并冷却抑制 24h（步骤 4c）
3. **幂等操作** — 映射表过滤防重复创建
4. **无 Label 依赖** — 状态全在映射表
5. **临时目录隔离** — 每个 PR 独立目录，互不干扰，PR 关闭时清理

## 依赖

`gh` CLI · `lark-cli` · `workspace/bot-chat-mapping.json`（BotChatMappingStore）· `github-jwt-auth` skill（按需刷新 `GH_TOKEN`，每小时过期；见步骤 0）

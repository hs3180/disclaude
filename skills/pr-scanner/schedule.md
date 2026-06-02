---
name: "PR Scanner"
cron: "*/30 * * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# PR Scanner — 定时扫描

每 30 分钟执行一次 PR Scanner skill。

## 执行流程

### 1. 限流检查

在调用 `pr-scanner` skill 之前，先检查映射表中 `purpose: 'pr-review'` 的条目数：
- 若 ≥ `{maxConcurrent}` → 跳过本次扫描，记录日志
- 否则 → 继续

### 2. 调用 pr-scanner skill

使用 `pr-scanner` skill 扫描仓库 `{repo}` 的 open PR。Skill 会完成：扫描 PR → 创建讨论群 → 写入映射。

参数：
- **仓库**: {repo}

### 3. 邀请用户

对每个新创建的群，使用 lark-cli 邀请指定用户：

```bash
lark-cli im chat.members --chat-id {新群chatId} --add --users {inviteUsers} --as bot
```

仅在 `{inviteUsers}` 非空时执行。

### 4. 注入 Review Agent 指令

对每个新创建的群，使用 `push_to_agent` 向群聊注入 PR review 指令：

> **变量替换**: `{number}`、`{repo}`、`{headRefName}` 从步骤 2 扫描得到的 PR 列表中替换。`{新群chatId}` 为 skill 创建群后返回的 chatId。

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

如果 `push_to_agent` 失败 → 记录错误并报告到控制频道；群已创建但 Agent 未初始化（用户可手动在群中触发）。

## 安装说明

将此文件复制到 `schedules/pr-scanner/SCHEDULE.md`，然后替换以下占位符：

| 占位符 | 替换为 |
|--------|--------|
| `{controlChannelChatId}` | 实际的控制频道 chatId |
| `{repo}` | 实际监控的 GitHub 仓库（如 `owner/repo`） |
| `{maxConcurrent}` | 并发上限（默认 `3`） |
| `{inviteUsers}` | 逗号分隔的飞书 open_id（如 `ou_xxx,ou_yyy`），留空则不邀请额外用户 |

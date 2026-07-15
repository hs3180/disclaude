---
name: "Issue Solver — Scan"
cron: "{cron}"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Issue Solver — 定时扫描

你必须完成以下任务：扫描 open issues，剔除有 open PR 的，从中选择一个 issue，在临时目录中实现修复并提交 PR。

## ⚠️ 边界（必须遵守，不可越界）

以下红线适用于每一轮 tick，**无论 CI 是否全绿、无论 PR 是否 MERGEABLE**：

1. **禁止 self-merge**：不得合并自己开的 PR，也不得合并任何其他 PR。PR 提交后即结束本轮——等待人工 reviewer 显式 sign-off。CI 全绿 ≠ 授权合并。
2. **禁止 close / reopen 任何 issue 或 PR**（包括自己开的、以及「看似已完成」的）。issue 的关闭交由 owner 或 PR 的 close 关键字自然触发，不要手动操作。
3. **禁止 force-push、禁止改写他人分支、禁止在他人 PR 上提交**。
4. **每轮最多开 1 个 PR**：选一个最小子任务，实现、测试、提交、报告，结束。
5. **禁止 delta-standby 空转**：候选集非空就必须挑选 + 实现 + PR；唯一允许「无操作」的情形是脚本输出「无候选 issue」。

> 违反上述任一条（尤其第 1、2 条）会直接导致 schedule 被再次禁用。

> ⚠️ **每轮必须推进**：只要脚本输出 ≥1 个候选 issue，就必须挑选其中一个、实现最小可交付子任务并提交 PR。**禁止**以「无新 issue」「无干净切片」「已有 open PR 在等 review」为由待命或跳过。候选集为空（`Candidates: 0`）是唯一允许的无操作情形。

## 你的任务

### 第一步：运行扫描脚本

执行以下命令：

```bash
node schedules/{scheduleDir}/scan.mjs
```

脚本会输出候选 issue 列表（Markdown 格式，包含标题、描述、评论），已自动剔除有 open PR 的 issue。

### 第二步：选择一个 issue 并确定最小可实现范围

根据脚本输出的标题和描述，选择一个 issue。**重要**：不要因为 issue 很大就跳过。大型 issue 应拆分为可独立交付的小部分，每次只实现其中一个具体、可验证的子任务。

选择策略：
1. 优先选择有明确、独立子任务的 issue
2. 从 issue 描述中识别一个**最小可实现单元**（如：添加一个配置项、创建一个空模块、补充一段文档、实现一个辅助函数）
3. 在 PR 标题和描述中注明这是该 issue 的第 N 部分，说明本次实现的范围

**绝对不要跳过候选 issue**。每个 issue 都有可以推进的部分。如果你认为某个 issue 确实完全无法下手，在报告中说明原因。

### 第三步：克隆仓库到临时目录

```bash
cd /tmp && rm -rf disclaude-issue-$ISSUE_NUMBER && git clone https://github.com/{repo}.git disclaude-issue-$ISSUE_NUMBER
```

### 第四步：实现选定的子任务

```bash
cd /tmp/disclaude-issue-$ISSUE_NUMBER
```

根据 issue 描述阅读代码，实现你选定的最小子任务。确保：
- 修改是自包含的，不依赖后续工作
- 有明确的交付物（代码、配置、测试等）
- 不破坏现有功能

### 第五步：运行测试

确保你的修改不破坏现有测试。

### 第六步：提交 PR

```bash
git checkout -b fix/issue-$ISSUE_NUMBER
git add -A && git commit -m "fix #$ISSUE_NUMBER: ..."
git push origin fix/issue-$ISSUE_NUMBER
```

PR 标题格式：`fix #$ISSUE_NUMBER (part N): 简述本次修改内容`
PR body 中说明：本 PR 实现了 issue 的哪个子任务，后续还剩哪些部分。

```bash
GH_TOKEN=$(grep '^GH_TOKEN=' /data/workspace/.runtime-env | sed 's/^GH_TOKEN=//' | tr -d '"'\'') gh pr create --title "fix #$ISSUE_NUMBER (part N): ..." --body "Related #$ISSUE_NUMBER" --head fix/issue-$ISSUE_NUMBER
```

### 第七步：报告结果

在控制频道（当前聊天）发送 PR 链接和本次实现的子任务说明。

---

若脚本输出无候选 issue，直接回复"无候选 issue"并结束，不做任何操作。

---

若脚本输出无候选 issue，直接回复"无候选 issue"并结束，不做任何操作。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `TARGET_REPO` | 否 | 目标仓库（owner/repo 格式，默认 `hs3180/disclaude`） |
| `GITHUB_APP_ID` | 是 | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 是 | GitHub App 私钥 PEM 文件路径 |
| `GITHUB_APP_INSTALLATION_ID` | 否 | Installation ID（自动检测） |

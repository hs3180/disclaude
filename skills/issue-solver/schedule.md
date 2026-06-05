---
name: "Issue Solver — Scan"
cron: "{cron}"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Issue Solver — 定时扫描

你必须完成以下任务：扫描 open issues，剔除有 open PR 的，从中选择一个 issue，在临时目录中实现修复并提交 PR。

## 你的任务

### 第一步：运行扫描脚本

执行以下命令：

```bash
node schedules/issue-solver/scan.mjs
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
GH_TOKEN=$(grep '^GH_TOKEN=' /data/workspace/.runtime-env | cut -d= -f2) gh pr create --title "fix #$ISSUE_NUMBER (part N): ..." --body "Related #$ISSUE_NUMBER" --head fix/issue-$ISSUE_NUMBER
```

### 第七步：报告结果

在控制频道（当前聊天）发送 PR 链接和本次实现的子任务说明。

---

若脚本输出无候选 issue，回复"无候选 issue"并结束。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `TARGET_REPO` | 否 | 目标仓库（默认 `hs3180/disclaude`） |
| `GITHUB_APP_ID` | 是 | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 是 | GitHub App 私钥 PEM 文件路径 |
| `GITHUB_APP_INSTALLATION_ID` | 否 | Installation ID（自动检测） |

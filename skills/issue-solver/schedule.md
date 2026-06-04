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

### 第二步：选择一个 issue

根据脚本输出的标题和描述，凭你的直觉选择一个优先级最高、最适合当前处理的 issue。

### 第三步：克隆仓库到临时目录

```bash
cd /tmp && rm -rf disclaude-issue-$ISSUE_NUMBER && git clone https://github.com/hs3180/disclaude.git disclaude-issue-$ISSUE_NUMBER
```

### 第四步：在临时目录中实现修复

```bash
cd /tmp/disclaude-issue-$ISSUE_NUMBER
```

根据 issue 描述阅读代码并修改实现修复。

### 第五步：运行测试

确保你的修改不破坏现有测试。

### 第六步：提交 PR

```bash
git checkout -b fix/issue-$ISSUE_NUMBER
git add -A && git commit -m "fix #$ISSUE_NUMBER: ..."
git push origin fix/issue-$ISSUE_NUMBER
gh pr create --title "fix #$ISSUE_NUMBER: ..." --body "Closes #$ISSUE_NUMBER"
```

### 第七步：报告结果

在控制频道（当前聊天）发送 PR 链接。

---

若脚本输出无候选 issue，直接回复"无候选 issue"并结束，不做任何操作。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `TARGET_REPO` | 否 | 目标仓库（默认 `hs3180/disclaude`） |
| `GITHUB_APP_ID` | 是 | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 是 | GitHub App 私钥 PEM 文件路径 |
| `GITHUB_APP_INSTALLATION_ID` | 否 | Installation ID（自动检测） |

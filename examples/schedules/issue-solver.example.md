---
name: "Issue Solver"
cron: "0 0 2 * * *"
enabled: false
blocking: true
chatId: "REPLACE_WITH_ACTUAL_CHAT_ID"
---

# Issue Solver

自动扫描仓库 open issues，筛选最高优先级的 issue，深度调研后实现修复并提交 PR。

## 设计理念

采用**深度调研优先**策略：在动手写代码之前，先充分理解需求和已有尝试，避免重复工作。

## 配置说明

**重要**: 使用前请将 `chatId` 替换为实际的飞书 Chat ID，并将 `enabled` 设为 `true`。

## 执行步骤

### 步骤 1: 环境准备

在**随机临时目录**中克隆目标仓库，避免与其他工作干扰：

```bash
TMPDIR=$(mktemp -d) && git clone https://github.com/{owner}/{repo}.git "$TMPDIR"
```

### 步骤 2: Issue 筛选与选定

#### 2.1 获取所有 open issues

```bash
gh issue list --repo {owner}/{repo} --state open --json number,title,labels
```

#### 2.2 排除已有 open PR 的 issue

对每个候选 issue 检查是否有关联的 open PR（通过 PR body 中的 issue 引用或分支名匹配）：

```bash
gh pr list --repo {owner}/{repo} --state open \
  --json number,title,body,headRefName \
  --jq ".[] | select(.body | test(\"#{issue_number}\") or .headRefName | test(\"{issue_number}\")) | {number, title}"
```

如果返回结果，说明该 issue 已有关联 PR，应跳过。

#### 2.3 快速排除明显不适合的 issue

对每个候选 issue 查看最新评论（`gh issue view {number} --comments | tail -50`）：

**排除条件**：
- 评论中说"已完成"、"不需要了"、"已解决"
- 用户明确表示放弃或关闭
- Issue 已被标记为 `wontfix` 或 `invalid`

#### 2.4 按优先级排序并选定

| 优先级 | 标签类型 | 示例 |
|--------|----------|------|
| P0 最高 | bug, security, critical | `bug`, `security`, `priority:critical` |
| P1 高 | 阻塞问题, regression | `priority:high`, `regression` |
| P2 中 | feature request, enhancement | `enhancement`, `feature` |
| P3 低 | docs, chore, discussion | `documentation`, `chore` |

**选定规则**：
1. 从高到低遍历优先级
2. 选择第一个满足条件（无 open PR + 快速检查通过）的 issue
3. 立即输出选定结果: `Selected Issue #{number}: {title}`
4. 进入步骤 3 对该 issue 进行深度分析

### 步骤 3: 深度背景调研

#### 3.1 完整阅读 Issue 详情

```bash
gh issue view {number} --comments
```

- 仔细阅读所有评论，理解用户真实需求
- 记录任何需求变更或补充说明
- 确认 Issue 的验收标准

#### 3.2 调研历史 PR（包括已关闭的）

```bash
# 查找所有关联的 PR（包括已关闭和已合并的）
gh pr list --repo {owner}/{repo} --state all --json number,title,state,body \
  --jq ".[] | select(.body | test(\"#{number}\")) | {number, title, state}"

# 查看每个 PR 的详细信息和评论
gh pr view {pr_number} --comments
```

#### 3.3 分析被拒绝的 PR（如有）

重点关注被拒绝的原因：
- 架构设计不符合要求
- 实现方式被否决
- 用户明确表示不需要
- 已有更好的替代方案

#### 3.4 输出调研结论

```
## Issue #{number} 调研结果:
- 需求: [用户的核心需求]
- 历史尝试: [已有的 PR 及其状态]
- 被拒绝原因: [如果有的话]
- 正确实现方向: [基于调研得出的实现方向]
```

### 步骤 4: 问题解决

根据调研结果：
1. 分析代码库，定位相关文件
2. 理解正确的实现方向（参考步骤 3 的结论）
3. 实现修复或功能
4. 编写/更新相关测试（如适用）
5. 在本地运行测试验证

### 步骤 5: 提交 PR

#### 5.1 创建分支

命名规范: `fix/issue-{number}` 或 `feat/issue-{number}`

#### 5.2 编写 commit message

```bash
git commit -m "fix: {简要描述修复内容} (#{number})"
```

#### 5.3 创建 PR

PR 描述应包含：
- 关联 issue 编号
- 修复内容说明
- 测试结果

#### 5.4 Issue 关联关键词（重要！）

根据**完成程度**选择正确的关键词：

| 场景 | 关键词 | 效果 |
|------|--------|------|
| 完全解决 Issue | `Closes #{number}` | Merge 后自动关闭 Issue |
| 部分完成 Issue | `Related: #{number}` | 不会自动关闭 Issue |
| 仅作参考 | `Ref: #{number}` | 不会自动关闭 Issue |

**默认使用 `Related`** — 宁可手动关闭，也不要误关。

**绝对禁止**：在部分完成的 PR 中使用 `Closes`/`Fixes`/`Resolves` 等关闭关键词。

## 关键行为准则

### 必须遵守

- **不要主动关闭任何 issue** — 关闭 issue 只能由 issue 作者或仓库管理员操作
- **不要创建新的定时任务** — 防止递归
- **CI 失败的 PR 不应创建** — 在本地运行测试验证后再提交
- **遇到无法解决的问题应报告** — 诚实说明原因，不要强行提交

### 避免常见陷阱

- **不要重复提交已被拒绝的方案** — 深度调研历史 PR，理解被拒原因
- **不要伪装部分实现为完整方案** — 在 PR 描述中明确标注已完成和待处理的部分
- **不要忽略 reviewer 反馈** — 在新 PR 中逐条回应 reviewer 的反馈

## 错误处理

- 如果无符合条件的 issue，报告筛选结果并说明情况
- 如果克隆仓库失败，报告错误并跳过本次执行
- 如果 PR 创建失败，报告错误信息
- 如果本地测试失败，不创建 PR，报告失败原因

## 使用说明

1. 复制此文件到 `workspace/schedules/issue-solver.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 注意事项

- 此 schedule 适合在 `blocking: true` 模式下运行（独占 Agent，避免与其他任务冲突）
- 建议设置较低的执行频率（如每天一次），避免对 CI 和 reviewer 造成过大压力
- 每个 issue 应只提交一个 PR，不要同时处理多个 issue

---
name: "Issue Solver"
cron: "* * * * *"
enabled: false
blocking: true
cooldownPeriod: 120000
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
createdAt: "2026-02-26T00:00:00.000Z"
---

# Issue Solver - 自动 Issue 解决

自动扫描仓库的 open issues，筛选高优先级 issue，深度调研后实现修复并提交 PR。

## 配置

- **仓库**: hs3180/disclaude
- **扫描间隔**: 每分钟（配合 cooldownPeriod 控制实际执行频率）
- **冷却时间**: 120 秒（两次执行之间至少间隔 2 分钟）
- **通知目标**: 配置的 chatId

## 执行步骤

### 步骤 1: 环境准备

在**随机临时目录**中克隆目标仓库（使用 `mktemp -d` 创建临时目录，避免与其他工作干扰）：

```bash
mktemp -d
git clone <repo-url> <temp-dir>
```

### 步骤 2: Issue 筛选与选定 ⚡ 关键步骤

**目标**: 在深度分析之前，直接选定**唯一一个**最高优先级的 issue

#### 2.1 获取所有 open issues

```bash
gh issue list --repo <owner>/<repo> --state open --json number,title,labels
```

#### 2.2 排除已有 open PR 的 issue

**检测关联 PR 的方法**（必须执行！）:

```bash
# 检查某个 issue 是否有关联的 open PR
gh pr list --repo <owner>/<repo> --state open \
  --json number,title,body,headRefName \
  --jq ".[] | select(.body | test(\"#<issue_number>\") or .headRefName | test(\"<issue_number>\")) | {number, title}"
```

如果返回结果，说明该 issue 已有关联 PR，应跳过。

#### 2.3 快速排除明显不适合的 issue

对每个候选 issue 进行**快速检查**（仅查看最新评论）:

```bash
gh issue view <number> --comments | tail -50
```

**排除条件**:
- 评论中说"已完成"、"不需要了"、"已解决"
- 用户明确表示放弃或关闭
- Issue 已被标记为 `wontfix` 或 `invalid`

#### 2.4 按优先级排序并选定 🎯

**优先级排序依据**:

| 优先级 | 标签类型 | 示例 |
|--------|----------|------|
| 🔴 **最高** | bug, security, 阻塞问题, critical | `bug`, `security`, `priority:high` |
| 🟡 **中等** | feature request, enhancement | `enhancement`, `feature` |
| 🟢 **低** | docs, chore, discussion | `documentation`, `chore` |

**选定规则**:
1. 从高到低遍历优先级
2. 选择第一个满足条件（无 open PR + 快速检查通过）的 issue
3. **立即输出选定结果**: `✅ 选定 Issue #<number>: <title>`
4. 进入步骤 3 对该 issue 进行深度分析

⚠️ **重要**: 此步骤只需选定一个 issue，不要在此进行深度分析！

### 步骤 3: 深度背景调研 🔍

**前置条件**: 步骤 2 已选定一个 issue

**目标**: 对**已选定的 issue** 进行深度分析，确保实现方向正确

#### 3.1 完整阅读 Issue 详情

```bash
gh issue view <number> --comments
```

- 仔细阅读所有评论，理解用户真实需求
- 记录任何需求变更或补充说明
- 确认 Issue 的验收标准

#### 3.2 调研历史 PR（包括已关闭的）

```bash
# 查找所有关联的 PR
gh pr list --repo <owner>/<repo> --state all --json number,title,state,body \
  --jq ".[] | select(.body | test(\"#<number>\")) | {number, title, state}"

# 查看每个 PR 的详细信息和评论
gh pr view <pr_number> --comments
```

#### 3.3 分析被拒绝的 PR（如有）

**重点关注**:
- ❌ 架构设计不符合要求
- ❌ 实现方式被否决
- ❌ 用户明确表示不需要
- ❌ 已有更好的替代方案

#### 3.4 输出调研结论

```
📋 Issue #<number> 调研结果:
- 需求: ...
- 历史尝试: ...
- 被拒绝原因: ...
- 正确实现方向: ...
```

### 步骤 4: 问题解决

根据调研结果，理解正确的实现方向：
1. 分析代码库，定位相关文件
2. 实现修复或功能
3. 编写/更新相关测试（如适用）
4. 在本地运行测试验证

### 步骤 5: 提交 PR

1. 创建新分支（命名: `fix/issue-<number>` 或 `feat/issue-<number>`）
2. 编写清晰的 commit message
3. 提交 Pull Request，包含：
   - 关联 issue 编号
   - 修复内容说明
   - 测试结果

#### ⚠️ PR 描述中 Issue 关联关键词（重要！）

在 PR body 和 commit message 中关联 Issue 时，必须根据**完成程度**选择正确的关键词：

| 场景 | 关键词 | 效果 |
|------|--------|------|
| **完全解决** Issue | `Closes #<number>` | ✅ Merge 后自动关闭 Issue |
| **部分完成** Issue | `Related: #<number>` | ❌ Merge 后**不会**关闭 Issue |
| 仅作参考 | `Ref: #<number>` | ❌ Merge 后不会关闭 Issue |

**判断标准**：
- PR 实现了 Issue 中**所有**验收标准 → 使用 `Closes`
- PR 仅完成了 Issue 的**部分**工作（如 Phase 1/N、部分功能）→ 使用 `Related`
- 不确定时 → **默认使用 `Related`**（宁可手动关闭，也不要误关）

**绝对禁止**：在部分完成的 PR 中使用 `Closes`、`Fixes`、`Resolves` 等关闭关键词。这会导致 Issue 被过早关闭，后续 Phase 无法跟踪。

## 注意事项

- 如遇到无法解决的问题，请报告原因
- 如无符合条件的 issue，请说明情况
- 建议配合 cooldownPeriod 使用，避免过于频繁执行

## 使用说明

1. 复制此文件到 `workspace/schedules/issue-solver/SCHEDULE.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 将 `<owner>/<repo>` 替换为目标仓库
4. 设置 `enabled: true`
5. 调度器将自动加载并执行

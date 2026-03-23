---
name: "Issue Solver"
cron: "0 0 */2 * * *"
enabled: false
blocking: true
chatId: "oc_REPLACE_WITH_YOUR_CHAT_ID"
cooldownPeriod: 3600000
---

# Issue Solver

自动扫描仓库的 open issues，经过深度调研后实现修复或功能并提交 PR。

## 设计理念

**深度调研优先** — 在动手写代码之前，先充分理解 issue 的真实需求和已有尝试，从历史失败中学习，避免重复提交被拒绝的方案。

## 配置

- **仓库**: hs3180/disclaude
- **执行间隔**: 每 2 小时
- **冷却期**: 1 小时（上次执行完成后）
- **工作目录**: 随机临时目录（`mktemp -d`），避免与其他任务干扰
- **通知目标**: 配置的 chatId

## 安全护栏

### 禁止操作

1. **绝对禁止** 关闭任何 issue — 只有 issue 作者或仓库管理员可以关闭
2. **绝对禁止** 创建新的定时任务 — 防止无限递归
3. **绝对禁止** 修改 issue 标签（除添加 `needs-human-review` 分析标签外）
4. **绝对禁止** 直接提交到受保护分支（`main`、`master`、`release/*`）

### 质量控制

5. **CI 前置检查** — 创建 PR 前必须通过完整 CI 检查（lint + type check + test）
6. **防重复方案** — 提交前必须调研所有历史 PR（含已关闭的），新方案必须与被拒方案有实质区别
7. **变更阈值** — 单 PR 超过 3 个文件或 200 行变更时，必须拆分为多个渐进式 PR
8. **生产集成验证** — 新功能必须说明入口点和调用路径，确保接入生产系统

### 反馈与迭代

9. **反馈响应** — 必须逐条回应 reviewer 反馈，未采纳的需给出技术理由
10. **MVP 优先** — 中等及以上复杂度的需求，默认先提交 MVP 版本获取反馈后再迭代
11. **PR 类型标注** — PR 描述中必须标注方案类型：`完整方案` / `MVP` / `部分实现`
12. **升降级策略** — 连续 2 次 CI 失败或 3 次 review 被拒，自动降级为人工处理并添加 `needs-human-review` 标签

## 执行步骤

### 步骤 1: 环境准备

在**随机临时目录**中克隆仓库：

```bash
TMPDIR=$(mktemp -d)
git clone https://github.com/hs3180/disclaude.git "$TMPDIR/disclaude"
cd "$TMPDIR/disclaude"
```

### 步骤 2: Issue 筛选与选定

#### 2.1 获取所有 open issues

```bash
gh issue list --repo hs3180/disclaude --state open \
  --json number,title,labels
```

#### 2.2 排除已有 open PR 的 issue

对每个候选 issue，检查是否有关联的 open PR：

```bash
gh pr list --repo hs3180/disclaude --state open \
  --json number,title,body,headRefName \
  --jq ".[] | select(.body | test(\"#{issue_number}\") or .headRefName | test(\"{issue_number}\")) | {number, title}"
```

如果返回结果，说明该 issue 已有 open PR，应跳过。

#### 2.3 快速排除明显不适合的 issue

对每个剩余候选 issue，查看最新评论：

```bash
gh issue view {number} --comments | tail -50
```

**排除条件**:
- 评论中说"已完成"、"不需要了"、"已解决"
- 用户明确表示放弃或关闭
- Issue 已被标记为 `wontfix` 或 `invalid`
- Issue 依赖其他尚未完成的功能
- Issue 已被标记为 `needs-human-review`（等待人工处理）

#### 2.4 按优先级排序并选定

| 优先级 | 标签类型 | 示例 |
|--------|----------|------|
| 🔴 最高 | bug, security, critical | `bug`, `security`, `priority:high` |
| 🟡 中等 | feature request, enhancement | `enhancement`, `feature` |
| 🟢 低 | docs, chore, discussion | `documentation`, `chore` |

**选定规则**:
1. 从高到低遍历优先级
2. 选择第一个满足条件（无 open PR + 快速检查通过）的 issue
3. 立即输出选定结果
4. 进入步骤 3 对该 issue 进行深度分析

### 步骤 3: 深度背景调研

> **前置条件**: 步骤 2 已选定一个 issue

#### 3.1 完整阅读 Issue 详情

```bash
gh issue view {number} --comments
```

- 仔细阅读所有评论，理解用户真实需求
- 记录任何需求变更或补充说明
- 确认 Issue 的验收标准

#### 3.2 调研历史 PR（包括已关闭的）

```bash
# 查找所有关联的 PR（含已关闭）
gh pr list --repo hs3180/disclaude --state all \
  --json number,title,state,body \
  --jq ".[] | select(.body | test(\"#{number}\")) | {number, title, state}"

# 查看每个历史 PR 的详细信息和评论
gh pr view {pr_number} --comments
```

#### 3.3 分析被拒绝的 PR（如有）

**重点关注**:
- ❌ 架构设计不符合要求
- ❌ 实现方式被否决
- ❌ 用户明确表示不需要
- ❌ 已有更好的替代方案
- ❌ 过度工程化
- ❌ 在错误的位置实现（应该重构到其他模块）

#### 3.4 评估实现复杂度

根据调研结果评估需求复杂度：

| 复杂度 | 判定标准 | 策略 |
|--------|----------|------|
| 🟢 低 | 单文件、<100 行变更 | 直接完整实现 |
| 🟡 中 | 2-3 文件、100-200 行变更 | 优先 MVP，标注后续迭代 |
| 🔴 高 | >3 文件或 >200 行变更 | 必须拆分，先提交核心 MVP |

#### 3.5 输出调研结论

```
📋 Issue #{number} 调研结果:
- 需求: ...
- 复杂度: 低/中/高
- 历史尝试: ...
- 被拒绝原因: ...
- 正确实现方向: ...
- 拆分计划（如适用）: ...
```

### 步骤 4: 问题解决

根据调研结果进行实现：

1. **理解正确的实现方向** — 基于步骤 3 的调研结论
2. **分析代码库** — 定位相关文件和调用链路
3. **确认生产集成点** — 新功能需要在哪些入口注册
4. **实现修复或功能** — 遵循项目现有代码风格和架构
5. **编写/更新测试** — 如适用
6. **本地验证** — 在临时目录中运行完整 CI 检查

**质量要求**:
- 不实现过度工程化的方案
- 不引入不必要的抽象层
- 不在缺少调用方的情况下预先构建框架
- 确保代码通过 lint 和类型检查
- 确保所有测试通过

**复杂度处理**:
- 🟢 低复杂度：完整实现，PR 类型标注为 `完整方案`
- 🟡 中复杂度：实现核心功能，PR 类型标注为 `MVP`，描述中列出后续迭代计划
- 🔴 高复杂度：仅实现最核心的 MVP 部分，PR 类型标注为 `MVP`，在 issue 中说明拆分计划

### 步骤 5: 提交 PR

1. 创建新分支（命名: `fix/issue-{number}` 或 `feat/issue-{number}`）
2. 编写清晰的 commit message
3. 本地运行完整 CI 检查（lint + type check + test）
4. 确认 CI 通过后再提交 Pull Request

**PR 描述模板**:

```markdown
## Summary

- {变更概述，1-3 个要点}

## Type

- [ ] 完整方案
- [x] MVP（最小可行版本）
- [ ] 部分实现

## Problem

{问题描述}

## Solution

{方案说明}

## Integration Points

{入口点和调用路径说明}

## Done / TODO

### ✅ 已完成
- {已完成的内容}

### 📋 后续迭代（如适用）
- {待后续处理的内容}
```

5. 提交 PR 时关联 issue：`Fixes #{number}` 或 `Closes #{number}`

## 异常处理

### 无法解决的 Issue

如遇到以下情况，发送报告说明原因后跳过：

- Issue 被其他 issue 阻塞（在报告中说明阻塞关系）
- Issue 需求不明确且无法从评论中推断
- 实现所需的技术前提条件不满足
- 连续 2 次尝试均 CI 失败（添加 `needs-human-review` 标签后跳过）

### 无符合条件的 Issue

如所有 issue 都已有 PR 或被阻塞：

- 发送汇总报告，列出所有 open issue 及其状态
- 说明哪些有 PR、哪些被阻塞、哪些被排除
- 建议下次执行时可以关注的 issue

## 使用说明

1. 复制此文件到 `workspace/schedules/issue-solver.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

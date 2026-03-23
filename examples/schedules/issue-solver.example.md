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

## ⚠️ 重要规则

1. **绝对禁止** 关闭任何 issue — 只有 issue 作者或仓库管理员可以关闭
2. **绝对禁止** 创建新的定时任务 — 防止无限递归
3. **必须** 在本地通过完整 CI 检查后再提交 PR
4. **必须** 先调研历史 PR（含已关闭的），分析被拒原因
5. **必须** 每次只选定一个 issue，集中精力

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

#### 3.4 输出调研结论

```
📋 Issue #{number} 调研结果:
- 需求: ...
- 历史尝试: ...
- 被拒绝原因: ...
- 正确实现方向: ...
```

### 步骤 4: 问题解决

根据调研结果进行实现：

1. **理解正确的实现方向** — 基于步骤 3 的调研结论
2. **分析代码库** — 定位相关文件和调用链路
3. **实现修复或功能** — 遵循项目现有代码风格和架构
4. **编写/更新测试** — 如适用
5. **本地验证** — 在临时目录中运行测试

**质量要求**:
- 不实现过度工程化的方案
- 不引入不必要的抽象层
- 不在缺少调用方的情况下预先构建框架
- 确保代码通过 lint 和类型检查

### 步骤 5: 提交 PR

1. 创建新分支（命名: `fix/issue-{number}` 或 `feat/issue-{number}`）
2. 编写清晰的 commit message
3. 本地运行完整 CI 检查
4. 提交 Pull Request，包含:
   - 关联 issue 编号（`Fixes #{number}` 或 `Closes #{number}`）
   - 修复内容说明
   - 调研结论摘要
   - 测试结果

## 使用说明

1. 复制此文件到 `workspace/schedules/issue-solver.md`
2. 将 `chatId` 替换为实际的飞书群聊 ID
3. 设置 `enabled: true`
4. 调度器将自动加载并执行

## 注意事项

- 如遇到无法解决的问题（如 issue 被其他 issue 阻塞），发送报告说明情况后跳过
- 如无符合条件的 issue（所有 issue 都已有 PR 或被阻塞），发送报告说明情况
- 单次执行完成后进入冷却期，避免频繁触发

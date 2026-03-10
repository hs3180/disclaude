---
type: blocking
purpose: pr-review
channel:
  type: group
  name: "PR #123 审核"
  members: []
context:
  prNumber: 123
  repository: hs3180/disclaude
  title: "feat: 添加新功能"
  author: developer
  headRef: feature-branch
  baseRef: main
  additions: 150
  deletions: 30
  changedFiles: 5
  mergeable: true
  ciStatus: "success"
expiresIn: 24h
---

# 🔔 PR 审核请求

检测到新的 PR 需要审核。

## PR 信息

| 属性 | 值 |
|------|-----|
| 📌 编号 | #123 |
| 📝 标题 | feat: 添加新功能 |
| 👤 作者 | @developer |
| 🌿 分支 | feature-branch → main |
| 📊 合并状态 | ✅ 可合并 |
| 🔍 CI 检查 | ✅ 通过 |
| 📈 变更 | +150 -30 (5 files) |

### 描述摘要

[PR 描述内容...]

---

🔗 [查看 PR](https://github.com/hs3180/disclaude/pull/123)

## 请选择处理方式

- [merge] ✅ 合并 - 执行 PR 合并
- [request_changes] 🔄 请求修改 - 添加评论请求修改
- [close] ❌ 关闭 - 关闭此 PR
- [later] ⏳ 稍后处理 - 下次再处理

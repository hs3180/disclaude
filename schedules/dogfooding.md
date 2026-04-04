---
name: "Disclaude 自体验"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_your_chat_id"
createdAt: "2026-04-05T00:00:00.000Z"
---

# Disclaude 自体验 (Dogfooding)

每周一 10:00 自动执行一次自体验，以"新用户"视角模拟使用各项功能，生成体验报告。

## 执行步骤

### 1. 环境检查

读取当前版本和最近变更：

```bash
# 检查当前版本
cat package.json | grep '"version"' || echo "No package.json found"

# 检查最近变更
git log --oneline -10 2>/dev/null || echo "Not a git repo"

# 检查可用技能
ls skills/ 2>/dev/null || echo "No skills directory"
```

### 2. 选择体验活动

**不要使用固定清单！** 自主选择 2-4 个体验活动：

- 优先选择最近有变更的功能
- 尝试之前没测过的领域
- 以"新用户"的好奇心驱动选择
- 参考 dogfooding skill 中的活动灵感库

### 3. 执行体验

对每个活动：
1. 描述你要做什么（像新用户一样思考）
2. 执行活动
3. 记录观察结果

### 4. 生成报告

按照 dogfooding skill 中的报告模板生成结构化报告。

### 5. 保存和发送

```bash
# 保存报告
mkdir -p workspace/dogfooding
TIMESTAMP=$(date -u +"%Y-%m-%dT%H%M:%SZ")
echo "[report]" > "workspace/dogfooding/${TIMESTAMP}.md"
```

使用 `send_user_feedback` 发送报告摘要到当前 chatId。

## 配置说明

使用前需要修改：
1. `chatId`: 替换为实际的接收报告的群组/聊天 ID
2. `enabled`: 设置为 `true` 启用
3. `cron`: 根据需要调整频率（建议每周一次）

## 注意事项

- 自主选择活动，不要每次都执行相同的测试
- 重点关注用户体验而非技术实现
- 高严重度问题通过 `gh issue create` 提交 GitHub Issue
- 低严重度问题记录在报告中即可

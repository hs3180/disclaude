---
name: "Dogfooding 自我体验测试"
cron: "0 10 * * 1"
enabled: false
blocking: true
chatId: "oc_71e5f41a029f3a120988b7ecb76df314"
createdAt: "2026-04-14T00:00:00.000Z"
---

# Dogfooding 自我体验测试

每周一上午 10:00 自动执行 disclaude 自我体验测试，以拟人化视角探索系统功能，发现潜在问题并反馈。

## 配置

- **执行频率**: 每周一 10:00
- **关联 Issue**: #1560
- **关联 Skill**: dogfooding

## 执行步骤

### 1. 检查版本变更

```bash
# 获取当前版本
CURRENT_VERSION=$(cat package.json | grep '"version"' | head -1 | sed 's/.*: "//;s/".*//')

# 获取上次测试版本
LAST_VERSION=""
if [ -f workspace/data/dogfooding-reports/last-version.txt ]; then
  LAST_VERSION=$(cat workspace/data/dogfooding-reports/last-version.txt)
fi

echo "Current: $CURRENT_VERSION | Last tested: ${LAST_VERSION:-never}"
```

### 2. 决定测试深度

**如果版本变更或首次运行**:
- 执行完整测试（Phase 1-5）
- 包含所有技能检查、探索性测试和报告生成

**如果版本未变**:
- 执行快速检查（Phase 1 + 部分 Phase 2）
- 仅检查新增/变更的文件
- 简要报告即可

### 3. 执行 Dogfooding Skill

调用 `dogfooding` skill 执行自我体验测试。

按照 skill 定义的 Phase 1-5 执行：
1. **环境发现**: 版本、技能清单、基础设施检查
2. **功能测试**: 逐一检查每个 skill 和 schedule
3. **探索性测试**: 模拟新用户体验 3-5 个场景
4. **报告生成**: 生成结构化测试报告
5. **Issue 提交**: 如有严重问题，提交 GitHub Issue

### 4. 更新版本记录

```bash
# 记录本次测试版本
mkdir -p workspace/data/dogfooding-reports
echo "$CURRENT_VERSION" > workspace/data/dogfooding-reports/last-version.txt
```

## 报告格式

测试完成后，通过 `send_user_feedback` 发送摘要报告到当前 chatId。

完整报告保存在 `workspace/data/dogfooding-reports/{YYYY-MM-DD}.md`。

## 错误处理

1. 如果 workspace 目录不可写，仅发送摘要到 chatId，不保存文件
2. 如果 `gh` CLI 不可用，跳过 Issue 提交步骤，在报告中标注
3. 如果测试过程中遇到异常，记录异常并继续其他测试项
4. 如果 send_user_feedback 失败，记录错误日志

## 注意事项

- **只读操作**: 测试过程中不修改源代码、不创建新 skill/schedule
- **安全第一**: 不暴露敏感信息（token、key、用户 ID）
- **Issue 去重**: 提交 Issue 前检查是否已存在相同问题
- **频率控制**: 一次测试最多提交 3 个 Issue

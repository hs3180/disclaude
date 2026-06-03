---
name: "Issue Solver — Scan"
cron: "0 */2 * * *"
enabled: true
blocking: true
chatId: "{controlChannelChatId}"
---

# Issue Solver — 定时扫描

每 2 小时执行一次 Issue 扫描，筛选出适合自动处理的 open issue。

## 执行流程

### 1. 运行 scan.mjs

```bash
node schedules/issue-solver/scan.mjs --debug
```

脚本会自动完成：
- 检查 `.runtime-env` 中的 GH_TOKEN 是否有效，过期则自动刷新
- 调用 `gh api` 获取 GitHub App Installation Access Token（使用 `gh` CLI，不依赖 `curl`）
- 扫描 open issues，过滤掉已有 PR、skip 标签、评论中已解决的 issue
- 按评分排序，输出 top N 候选 issue

### 2. 处理输出

脚本输出 Markdown 格式的候选 issue 列表。若无候选 issue，脚本输出提示信息并正常退出。

若存在候选 issue，将输出转发到控制频道，等待人工确认或自动分配给 agent 处理。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `GITHUB_APP_ID` | 是 | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | 是 | GitHub App 私钥 PEM 文件路径 |
| `GITHUB_APP_INSTALLATION_ID` | 否 | Installation ID（自动检测） |

## 输出文件

Token 写入项目根目录 `.runtime-env`（与 `packages/core/src/config/runtime-env.ts` 一致）。

## 测试

```bash
node schedules/issue-solver/scan.test.js
```

## 安装说明

将此文件放置在 `schedules/issue-solver/SCHEDULE.md`，替换 `{controlChannelChatId}` 为实际的控制频道 chatId。

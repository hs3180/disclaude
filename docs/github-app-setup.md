# GitHub App 配置指南

本文档详细介绍如何配置 GitHub App，使 Disclaude 能够通过 JWT 鉴权访问 GitHub API。

## 目录

- [1. 创建 GitHub App](#1-创建-github-app)
- [2. 配置权限](#2-配置权限)
- [3. 生成私钥](#3-生成私钥)
- [4. 安装到仓库](#4-安装到仓库)
- [5. 配置 Disclaude](#5-配置-disclaude)
- [6. 使用示例](#6-使用示例)
- [7. 常见场景](#7-常见场景)
- [8. 常见问题](#8-常见问题)

---

## 1. 创建 GitHub App

### 1.1 进入创建页面

1. 登录 [GitHub](https://github.com/)
2. 点击右上角头像 → Settings
3. 在左侧菜单最下方点击「Developer settings」
4. 点击「GitHub Apps」→「New GitHub App」

> **组织级别**: 如果要创建组织级别的 App，进入组织的 Settings → Developer settings → GitHub Apps

### 1.2 填写基本信息

| 字段 | 建议值 | 说明 |
|------|--------|------|
| **GitHub App name** | `Disclaude Bot` | 全局唯一的 App 名称 |
| **Description** | `AI Agent for automated development tasks` | App 描述 |
| **Homepage URL** | `https://github.com/your-org/disclaude` | 项目主页 |
| **Callback URL** | 留空 | OAuth 回调（本场景不需要） |
| **Setup URL** | 留空 | 安装引导页（可选） |
| **Webhook** | 取消勾选 Active | 不需要 Webhook |

### 1.3 标识信息

创建完成后，在 App 设置页面记录以下信息：

| 信息 | 说明 | 用途 |
|------|------|------|
| **App ID** | 应用唯一标识 | 配置文件中的 `github.appId` |
| **Client ID** | 客户端标识 | OAuth 场景使用 |
| **App slug** | URL 友好名称 | 可用于 API 调用 |

---

## 2. 配置权限

### 2.1 Repository Permissions

在「Permissions & events」→「Repository permissions」页面配置：

| 权限 | 访问级别 | 用途 | 必需 |
|------|----------|------|------|
| **Contents** | Read and write | 读取/创建/更新文件 | ✅ 必需 |
| **Issues** | Read and write | 创建/评论/关闭 Issue | ✅ 必需 |
| **Pull requests** | Read and write | 创建/审查/合并 PR | ✅ 必需 |
| **Actions** | Read-only | 查看 CI 状态 | 可选 |
| **Metadata** | Read-only | 基本仓库信息 | ✅ 必需 |

### 2.2 Organization Permissions (可选)

如果需要访问组织级别资源：

| 权限 | 访问级别 | 用途 |
|------|----------|------|
| **Members** | Read-only | 查看组织成员 |

### 2.3 Subscribe to events (可选)

如果使用 Webhook，可以订阅以下事件：
- `push` - 代码推送
- `pull_request` - PR 事件
- `issues` - Issue 事件

---

## 3. 生成私钥

### 3.1 生成私钥文件

1. 在 App 设置页面，滚动到「Private keys」部分
2. 点击「Generate a private key」
3. 浏览器会自动下载 `.pem` 文件（如 `disclaude-bot.2026-03-10.private-key.pem`）

> ⚠️ **安全提示**: 私钥文件非常重要，请妥善保管，不要提交到代码仓库！

### 3.2 存放私钥

将私钥文件存放在安全位置：

```bash
# 建议存放在项目根目录外的安全位置
mkdir -p ~/.config/disclaude
mv ~/Downloads/disclaude-bot.*.private-key.pem ~/.config/disclaude/github-app.pem
chmod 600 ~/.config/disclaude/github-app.pem
```

---

## 4. 安装到仓库

### 4.1 安装 App

1. 在 App 设置页面，点击「Install App」
2. 选择安装目标：
   - **个人账户**: 安装到个人仓库
   - **组织**: 安装到组织仓库
3. 选择仓库访问范围：
   - **All repositories**: 所有仓库
   - **Only select repositories**: 仅选定仓库（推荐）

### 4.2 获取 Installation ID

安装完成后，URL 会变成类似：
```
https://github.com/settings/installations/12345678
```

其中 `12345678` 就是 **Installation ID**，记录下来用于配置。

> **提示**: 也可以通过 API 获取 Installation ID：
> ```bash
> # 使用 App 私钥生成 JWT 后调用
> curl -H "Authorization: Bearer YOUR_JWT" \
>   https://api.github.com/app/installations
> ```

---

## 5. 配置 Disclaude

### 5.1 配置文件

编辑 `disclaude.config.yaml`，添加 GitHub App 配置：

```yaml
# GitHub App 配置 (用于 JWT 鉴权)
github:
  # App ID (从 GitHub App 设置页面获取)
  appId: "123456"

  # 私钥文件路径 (相对于项目根目录或绝对路径)
  privateKeyPath: "./github-app.pem"

  # Installation ID (从安装页面 URL 获取)
  installationId: "78901234"
```

### 5.2 环境变量 (推荐)

更安全的方式是使用环境变量：

```bash
# .env 或系统环境变量
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY=$(cat ~/.config/disclaude/github-app.pem | base64)
GITHUB_INSTALLATION_ID=78901234
```

配置文件：

```yaml
github:
  appId: "${GITHUB_APP_ID}"
  privateKeyPath: "${GITHUB_APP_PRIVATE_KEY_PATH:./github-app.pem}"
  installationId: "${GITHUB_INSTALLATION_ID}"
```

### 5.3 使用 gh CLI (替代方案)

如果已配置 `gh` CLI 并登录，可以直接使用：

```bash
# 检查登录状态
gh auth status

# 如果已登录，Schedule/Skill 可以直接使用 gh 命令
gh pr list --repo owner/repo
```

---

## 6. 使用示例

### 6.1 在 Schedule 中使用

创建 `workspace/schedules/issue-solver.md`：

```markdown
---
name: "Issue Solver"
cron: "0 0 * * * *"
enabled: true
blocking: true
chatId: "oc_your_chat_id"
---

# Issue Solver

自动处理 GitHub Issues。

## 步骤

1. 获取 open issues:
   ```bash
   gh issue list --repo owner/repo --state open --json number,title,labels
   ```

2. 选择优先级最高的 issue

3. 分析并解决问题

4. 提交 PR:
   ```bash
   gh pr create --repo owner/repo --title "fix: ..." --body "..."
   ```
```

### 6.2 在 Skill 中使用

Skill 可以通过 `gh` CLI 访问 GitHub API：

```markdown
# PR Scanner Skill

扫描仓库中的 PR 并提供分析。

## Usage

1. 获取 PR 列表:
   ```bash
   gh pr list --repo owner/repo --state open --json number,title,author
   ```

2. 查看 PR 详情:
   ```bash
   gh pr view {number} --repo owner/repo
   ```

3. 添加评论:
   ```bash
   gh pr comment {number} --repo owner/repo --body "分析结果..."
   ```
```

### 6.3 API 调用示例

使用 JWT 鉴权直接调用 GitHub API：

```bash
# 生成 Installation Token (需要先实现 JWT 生成逻辑)
# 然后使用 token 调用 API
curl -H "Authorization: Bearer YOUR_INSTALLATION_TOKEN" \
  https://api.github.com/repos/owner/repo/issues
```

---

## 7. 常见场景

### 7.1 PR 扫描与自动评论

```markdown
---
name: "PR Scanner"
cron: "0 */30 * * * *"
---

# PR Scanner

扫描新 PR 并自动添加审查评论。

## 执行步骤

1. 获取新 PR 列表
2. 分析代码变更
3. 添加审查评论:
   ```bash
   gh pr comment {number} --repo owner/repo --body "审查意见..."
   ```
```

### 7.2 Issue 自动创建与更新

```bash
# 创建 Issue
gh issue create --repo owner/repo --title "Bug: ..." --body "描述..."

# 添加评论
gh issue comment {number} --repo owner/repo --body "更新..."

# 关闭 Issue
gh issue close {number} --repo owner/repo
```

### 7.3 代码审查自动化

```bash
# 获取 PR 文件列表
gh pr diff {number} --repo owner/repo

# 请求审查
gh pr edit {number} --repo owner/repo --add-reviewer username

# 合并 PR
gh pr merge {number} --repo owner/repo --squash
```

### 7.4 CI 状态监控

```bash
# 查看 PR 检查状态
gh pr view {number} --repo owner/repo --json statusCheckRollup

# 查看 workflow 运行状态
gh run list --repo owner/repo --limit 10
```

---

## 8. 常见问题

### Q1: 认证失败，提示 "Bad credentials"

**原因**: 私钥配置错误或已过期

**解决方案**:
1. 检查私钥文件路径是否正确
2. 确认私钥文件内容完整（包含 `-----BEGIN RSA PRIVATE KEY-----` 和 `-----END RSA PRIVATE KEY-----`）
3. 重新生成私钥并更新配置

### Q2: 权限不足，无法访问仓库

**原因**: App 未安装到目标仓库或权限不足

**解决方案**:
1. 检查 App 是否已安装到目标仓库
2. 确认 Repository permissions 配置正确
3. 如果使用 "Only select repositories"，确认目标仓库已选中

### Q3: Installation ID 在哪里找到？

**解决方案**:
1. 进入 GitHub Settings → Applications
2. 点击你的 App
3. 点击「Install App」
4. 点击已安装的组织/账户
5. URL 中的数字就是 Installation ID

### Q4: 如何在多仓库使用同一个 App？

**解决方案**:
1. 在 App 安装页面选择多个仓库
2. 或使用 "All repositories" 选项
3. 每个仓库使用相同的 App ID 和私钥
4. Installation ID 相同（同一安装）

### Q5: gh CLI 和 GitHub App 有什么区别？

| 方式 | 优点 | 缺点 |
|------|------|------|
| `gh` CLI | 简单易用，本地开发友好 | 需要手动登录，不适合服务端 |
| GitHub App | 适合自动化，权限精细 | 配置复杂，需要管理私钥 |

**建议**:
- 本地开发使用 `gh` CLI
- 服务端/自动化任务使用 GitHub App

### Q6: 私钥文件应该放在哪里？

**建议**:
- **开发环境**: 项目根目录的 `.secrets/` 文件夹（加入 .gitignore）
- **生产环境**: 使用环境变量或密钥管理服务
- **永远不要**: 提交到 Git 仓库

```bash
# .gitignore
.secrets/
*.pem
*.key
```

### Q7: 如何调试 GitHub App 认证问题？

**解决方案**:
1. 使用 GitHub API 测试 JWT：
   ```bash
   # 获取 App 信息（验证 JWT）
   curl -H "Authorization: Bearer YOUR_JWT" https://api.github.com/app
   ```
2. 查看日志中的错误信息
3. 使用 GitHub App 的「Advanced」页面查看最近的请求

---

## 权限速查表

| 功能 | 所需权限 |
|------|---------|
| 读取文件 | `contents: read` |
| 创建/更新文件 | `contents: write` |
| 创建/评论 Issue | `issues: write` |
| 创建/审查 PR | `pull_requests: write` |
| 查看 CI 状态 | `actions: read` |
| 查看组织成员 | `members: read` (组织级别) |

---

## 相关链接

- [GitHub Apps 文档](https://docs.github.com/en/apps)
- [GitHub App JWT 认证](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [GitHub API 权限列表](https://docs.github.com/en/rest/permissions)
- [gh CLI 手册](https://cli.github.com/manual/)

---

## 获取帮助

如果遇到问题，可以：

1. 查看 [GitHub Apps 官方文档](https://docs.github.com/en/apps)
2. 在 [GitHub Issues](https://github.com/hs3180/disclaude/issues) 提交问题
3. 检查 Disclaude 服务日志排查错误

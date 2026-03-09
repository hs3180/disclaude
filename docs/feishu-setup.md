# 飞书应用配置指南

本文档详细介绍如何创建和配置飞书机器人应用，以便与 Disclaude 配合使用。

## 目录

1. [创建飞书应用](#1-创建飞书应用)
2. [启用机器人能力](#2-启用机器人能力)
3. [配置权限](#3-配置权限)
4. [配置事件订阅](#4-配置事件订阅)
5. [发布应用](#5-发布应用)
6. [配置 Disclaude](#6-配置-disclaude)
7. [常见问题](#7-常见问题)

---

## 1. 创建飞书应用

### 1.1 登录飞书开放平台

访问 [飞书开放平台](https://open.feishu.cn/) 并使用飞书账号登录。

> **国际版用户**: 请访问 [Lark Developer](https://open.larksuite.com/)

### 1.2 创建企业自建应用

1. 点击「开发者后台」→「创建企业自建应用」
2. 填写应用基本信息：
   - **应用名称**: 如 `Disclaude Bot`
   - **应用描述**: AI Agent 助手机器人
   - **应用图标**: 上传自定义图标
3. 点击「创建」

### 1.3 获取应用凭证

创建完成后，在「凭证与基础信息」页面获取：
- **App ID**: 应用的唯一标识
- **App Secret**: 应用的密钥（点击显示获取）

> ⚠️ **重要**: App Secret 需妥善保管，不要泄露或提交到代码仓库。

---

## 2. 启用机器人能力

1. 进入应用管理页面
2. 点击左侧菜单「应用功能」→「机器人」
3. 开启「启用机器人」开关
4. 配置机器人信息：
   - **机器人名称**: 显示在聊天中的名称
   - **机器人描述**: 简要描述机器人功能
   - **机器人头像**: 上传机器人头像

---

## 3. 配置权限

Disclaude 需要以下权限才能正常工作。在「权限管理」页面申请相应权限。

### 3.1 消息相关权限

| 权限 Scope | 描述 | 用途 |
|-----------|------|------|
| `im:message` | 获取与发送单聊、群聊消息 | 接收和发送聊天消息 |
| `im:message:send_as_bot` | 以应用身份发消息 | 机器人身份发送消息 |
| `im:resource` | 获取消息中的资源 | 获取图片、文件等资源 |
| `im:reaction` | 获取与更新表情回复 | 添加消息表情反应 |

### 3.2 文件相关权限

| 权限 Scope | 描述 | 用途 |
|-----------|------|------|
| `im:image` | 上传、下载图片 | 发送图片消息 |
| `im:file` | 上传、下载文件 | 发送文件消息 |
| `drive:file:readonly` | 查看云空间文件 | 下载云盘文件 |

### 3.3 群组相关权限

| 权限 Scope | 描述 | 用途 |
|-----------|------|------|
| `im:chat` | 获取与更新群组信息 | 创建、获取群组信息 |
| `im:chat:member` | 获取与更新群成员信息 | 管理群组成员 |

### 3.4 申请权限步骤

1. 在「权限管理」页面
2. 搜索上述权限名称或 Scope
3. 点击「申请权限」
4. 填写申请理由（如：AI 助手机器人需要接收和发送消息）
5. 等待管理员审批

> 💡 **提示**: 部分敏感权限可能需要企业管理员审批。

---

## 4. 配置事件订阅

Disclaude 使用 WebSocket 长连接模式接收事件，无需配置公网服务器。

### 4.1 启用长连接

1. 进入「事件与回调」页面
2. 在「事件订阅」区域
3. 选择「使用长连接接收事件」模式

### 4.2 订阅消息事件

添加以下事件：
- `im.message.receive_v1` - 接收消息

### 4.3 长连接模式优势

- ✅ 无需公网 IP
- ✅ 无需配置 Webhook URL
- ✅ 无需处理签名验证
- ✅ 支持本地开发调试

---

## 5. 发布应用

### 5.1 创建版本

1. 进入「版本管理与发布」页面
2. 点击「创建版本」
3. 填写版本信息：
   - **版本号**: 如 `1.0.0`
   - **更新说明**: 初始版本
4. 点击「保存」

### 5.2 申请发布

1. 点击「申请发布」
2. 等待企业管理员审批
3. 审批通过后，应用将发布到企业

### 5.3 添加机器人到群聊

1. 在飞书群聊中点击「设置」
2. 点击「群机器人」
3. 点击「添加机器人」
4. 选择你的机器人

---

## 6. 配置 Disclaude

### 6.1 编辑配置文件

复制示例配置文件：

```bash
cp disclaude.config.example.yaml disclaude.config.yaml
```

编辑 `disclaude.config.yaml`，填入飞书应用凭证：

```yaml
feishu:
  appId: "cli_xxxxxxxxxxxx"      # 替换为你的 App ID
  appSecret: "xxxxxxxxxxxxxxxx"  # 替换为你的 App Secret
```

### 6.2 启动 Disclaude

```bash
# 安装依赖
npm install

# 构建
npm run build

# 启动飞书模式
disclaude start --mode feishu
```

### 6.3 验证连接

启动后，日志应显示：

```
[INFO] Feishu WebSocket connected
[INFO] Bot is ready
```

在飞书中向机器人发送消息，应该能收到回复。

---

## 7. 常见问题

### Q1: WebSocket 连接失败

**症状**: 日志显示连接错误或超时

**解决方案**:
1. 检查网络是否能访问飞书服务器
2. 确认 App ID 和 App Secret 正确
3. 确认已启用「长连接」模式

### Q2: 权限不足错误

**症状**: 日志显示 `permission denied` 或 `no permission`

**解决方案**:
1. 检查是否已申请所有必需权限
2. 确认权限已通过审批
3. 检查应用是否已发布

### Q3: 收不到消息事件

**症状**: 机器人不响应消息

**解决方案**:
1. 确认已订阅 `im.message.receive_v1` 事件
2. 确认长连接已建立
3. 检查机器人是否已添加到群聊或启用私聊

### Q4: 消息发送失败

**症状**: 日志显示消息发送错误

**解决方案**:
1. 检查 `im:message` 和 `im:message:send_as_bot` 权限
2. 确认机器人仍在群聊中
3. 检查消息内容是否符合飞书规范

### Q5: 图片/文件无法获取

**症状**: 日志显示资源获取错误

**解决方案**:
1. 检查 `im:resource` 权限
2. 检查 `im:image` 和 `im:file` 权限
3. 如果是云盘文件，检查 `drive:file:readonly` 权限

### Q6: 无法创建或管理群组

**症状**: 群组操作失败

**解决方案**:
1. 检查 `im:chat` 和 `im:chat:member` 权限
2. 确认机器人有群组管理权限

---

## 相关链接

- [飞书开放平台](https://open.feishu.cn/)
- [飞书开放平台文档](https://open.feishu.cn/document/home)
- [API 权限列表](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list)
- [自建应用开发流程](https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process)
- [事件订阅指南](https://open.feishu.cn/document/client-docs/bot-v3/events/overview)

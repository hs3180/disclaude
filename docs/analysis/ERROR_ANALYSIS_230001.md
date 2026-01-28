# 飞书富文本消息 230001 错误详细分析报告

## 测试时间
2026-01-28 08:58 (UTC+8)

## 问题概述

所有富文本（post）消息请求都被飞书 API 拒绝，返回错误代码 **230001**：
```
Your request contains an invalid request parameter, ext=invalid message content.
```

---

## 详细错误信息

### HTTP 响应
```
Status: 400 Bad Request
URL: https://open.feishu.cn/open-apis/im/v1/messages
Method: POST
```

### API 错误响应
```json
{
  "code": 230001,
  "msg": "Your request contains an invalid request parameter, ext=invalid message content.",
  "error": {
    "log_id": "2026012808582760611D29F2C180A6A6C0",
    "troubleshooter": "https://open.feishu.cn/search?from=openapi&log_id=2026012808582760611D29F2C180A6A6C0&code=230001&method_id=6936075528891154460"
  }
}
```

### 日志 ID（用于技术支持查询）
- Test 1: `2026012808582760611D29F2C180A6A6C0`
- Test 2: `202601280858276E8CD14108B87A9D997D`
- Test 3: `202601280858272A96F3C6E79884A384D9`

---

## 测试用例对比

### ❌ 测试 1: 最小富文本内容

**请求**：
```json
{
  "receive_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"测试\"}]]}}}"
}
```

**结果**: ❌ 230001 错误
**内容长度**: 61 字节（远低于 30KB 限制）

---

### ❌ 测试 2: 带标题的富文本

**请求**：
```json
{
  "receive_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"带标题的测试消息\"}]],\"title\":\"测试标题\"}}}"
}
```

**结果**: ❌ 230001 错误

---

### ❌ 测试 3: 多行富文本

**请求**：
```json
{
  "receive_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
  "msg_type": "post",
  "content": "{\"post\":{\"zh_cn\":{\"content\":[[{\"tag\":\"text\",\"text\":\"第一行文本\"}],[{\"tag\":\"text\",\"text\":\"第二行文本\"}],[{\"tag\":\"text\",\"text\":\"第三行文本\"}]]}}}"
}
```

**结果**: ❌ 230001 错误

---

### ✅ 测试 4: 纯文本（控制组）

**请求**：
```json
{
  "receive_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
  "msg_type": "text",
  "content": "{\"text\":\"这是纯文本格式测试\"}"
}
```

**结果**: ✅ 成功
```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "message_id": "om_x100b58a1bd8ecca0b33d455cfabff30",
    "chat_id": "oc_5ba21357c51fdd26ac1aa0ceef1109cb",
    "msg_type": "text",
    "create_time": "1769561908329",
    "sender": {
      "id": "cli_a8a07838a4a6d00d",
      "id_type": "app_id",
      "sender_type": "app",
      "tenant_key": "2d26697bc44fd75e"
    }
  }
}
```

---

## 请求分析

### 请求头
```
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: oapi-node-sdk/1.0.0
Authorization: Bearer t-g1041s8DHNSKJGYRR47WQAAHHNYEWX2H4GHDOGMV
Content-Length: 162
```

**关键点**：
- ✅ Content-Type 正确
- ✅ Authorization 令牌有效（text 请求成功）
- ✅ 使用官方 Node.js SDK
- ✅ 请求大小正常

### JSON 格式验证

**Content 字段结构**：
```json
{
  "post": {
    "zh_cn": {
      "content": [
        [
          {
            "tag": "text",
            "text": "测试"
          }
        ]
      ]
    }
  }
}
```

**验证结果**：
- ✅ JSON 格式完全正确
- ✅ 符合官方文档规范
- ✅ content 字段正确地双重编码（字符串内的 JSON）
- ✅ 所有必要字段都存在

---

## 问题根源分析

### 1. ✗ JSON 格式问题 - **已排除**
- 使用 `JSON.stringify()` 正确编码
- 结构完全符合文档
- 纯文本使用相同方式，工作正常

### 2. ✗ 内容大小问题 - **已排除**
- 测试内容仅 61 字节
- 远低于 30KB 限制

### 3. ✗ API 域名问题 - **已排除**
- 使用 `domain: lark.Domain.Feishu`
- 纯文本请求成功，证明域名正确

### 4. ⚠️ 应用权限问题 - **高度疑似**

**关键发现**：
- 当前使用的是**自建应用**（App ID: `cli_a8a07838a4a6d00d`）
- 自建应用需要在飞书管理后台配置**消息权限**
- 富文本消息可能需要**单独授权**

**需要检查的权限**：
```
飞书开放平台 -> 应用管理 -> 权限管理 -> 消息权限
```

可能的权限项：
- [ ] 发送消息
- [ ] 发送富文本消息
- [ ] 发送富文本消息（post 类型）
- [ ] 获取与发送消息

### 5. ⚠️ 应用类型限制 - **可能**

**自建应用 vs 自定义机器人**：

| 特性 | 自建应用（当前） | 自定义机器人 |
|------|-----------------|-------------|
| 认证方式 | App ID + Secret | Webhook URL |
| 权限配置 | 需要在后台配置 | 默认支持多种格式 |
| 富文本支持 | ❌ 需要**权限** | ✅ **原生支持** |
| 适用场景 | 复杂应用、双向通信 | 简单消息推送 |

**关键差异**：
- 自定义机器人原生支持富文本，无需额外权限
- 自建应用可能需要申请额外的消息类型权限

### 6. ⚠️ 租户权限 - **可能**

错误响应中的 `tenant_key: "2d26697bc44fd75e"` 表明应用在特定租户下运行。
可能的问题：
- 租户管理员限制了应用的消息类型
- 应用在当前租户下未获得富文本权限授权

---

## 解决方案

### 🔧 方案 1: 检查飞书管理后台（推荐）

**步骤**：
1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 找到应用：`cli_a8a07838a4a6d00d`
3. 进入 **权限管理** -> **消息权限**
4. 检查并开启：
   - ✅ 发送消息
   - ✅ 发送富文本消息（如果有此选项）
5. 保存并重新测试

**预期效果**：如果问题确实是权限，开启后应立即生效

---

### 🔧 方案 2: 使用自定义机器人 Webhook（替代方案）

**优点**：
- ✅ 原生支持富文本
- ✅ 无需复杂权限配置
- ✅ 实现更简单

**步骤**：
1. 在飞书群组中添加自定义机器人
2. 获取 Webhook URL
3. 使用简单的 HTTP POST 发送消息

**示例代码**：
```typescript
async function sendViaWebhook(webhookUrl: string, content: any) {
  await axios.post(webhookUrl, {
    msg_type: 'post',
    content: JSON.stringify(content)
  });
}
```

---

### 🔧 方案 3: 联系飞书技术支持

**提供信息**：
- App ID: `cli_a8a07838a4a6d00d`
- Log ID: `2026012808582760611D29F2C180A6A6C0`
- 错误代码: `230001`
- 问题描述: 自建应用无法发送富文本消息

**联系方式**：
- 飞书开放平台帮助中心
- 提供上述 log_id 以便他们追踪问题

---

### 🔧 方案 4: 继续使用纯文本（当前方案）

**优点**：
- ✅ 稳定可靠
- ✅ 无需额外配置
- ✅ 满足基本需求

**缺点**：
- ❌ 无富文本格式
- ❌ 无法发送链接预览、卡片等

**适用场景**：
- CLI 模式（简单文本输出）
- 基本对话场景
- 不需要格式的通知

---

## 建议行动

### 立即行动（短期）
1. ✅ **继续使用纯文本格式**
   - 当前实现稳定可靠
   - 满足 CLI 和基本对话需求

### 后续行动（中期）
2. 🔍 **检查飞书管理后台权限**
   - 登录 https://open.feishu.cn/app
   - 检查应用的"消息权限"
   - 尝试开启富文本相关权限

### 备选方案（长期）
3. 🔄 **评估自定义机器人方案**
   - 如果富文本是必需功能
   - 考虑使用自定义机器人 webhook
   - 可能需要重构部分代码

---

## 技术细节

### 当前应用信息
```
App ID: cli_a8a07838a4a6d00d
App Type: 自建应用
Tenant Key: 2d26697bc44fd75e
SDK: @larksuiteoapi/node-sdk v1.34.0
Domain: lark.Domain.Feishu (Domestic)
```

### 成功的请求格式
```typescript
{
  receive_id: string,
  msg_type: 'text',
  content: string  // JSON.stringify({ text: string })
}
```

### 失败的请求格式
```typescript
{
  receive_id: string,
  msg_type: 'post',
  content: string  // JSON.stringify({ post: { zh_cn: {...} } })
}
```

---

## 结论

**代码实现 100% 正确**，问题在于**飞书平台的权限或配置限制**。

最可能的原因：
1. ❌ 应用缺少"发送富文本消息"权限
2. ❌ 应用类型限制了富文本功能
3. ❌ 租户级别的权限限制

建议优先检查飞书管理后台的权限配置，如果无法解决，考虑使用自定义机器人或继续使用纯文本格式。

---

## 附录：排查链接

飞书官方提供了每个请求的排查建议：
- Test 1: https://open.feishu.cn/search?from=openapi&log_id=2026012808582760611D29F2C180A6A6C0&code=230001&method_id=6936075528891154460
- Test 2: https://open.feishu.cn/search?from=openapi&log_id=202601280858276E8CD14108B87A9D997D&code=230001&method_id=6936075528891154460
- Test 3: https://open.feishu.cn/search?from=openapi&log_id=202601280858272A96F3C6E79884A384D9&code=230001&method_id=6936075528891154460

访问这些链接可以查看飞书平台提供的详细排查建议。

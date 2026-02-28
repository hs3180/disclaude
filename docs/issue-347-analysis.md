# Issue #347 方案分析与前置开发任务

## 背景

Issue #347 要求实现动态管理员设置与自动创建日志群功能。根据用户反馈，本 issue 的交付目标为**方案分析和前置开发任务分析**。

### 原始需求

1. **动态管理员设置**：用户通过对话开启/关闭管理员模式
2. **自动创建日志群**：为开启管理员模式的用户创建专属日志群
3. **群聊管理**：支持用户退出/保留日志群

### 已有关闭 PR

- **PR #348** (已关闭)：被关闭原因为"还有大量的必须前置能力未实现，该实现不成熟"

---

## 当前能力分析

### 已有能力

| 能力 | 位置 | 状态 |
|------|------|------|
| 消息发送 | `src/platforms/feishu/feishu-message-sender.ts` | ✅ 完整 |
| 消息路由 | `src/messaging/message-router.ts` | ✅ 完整 |
| 消息级别管理 | `src/messaging/types.ts` (MessageLevel) | ✅ 完整 |
| 消息历史存储 | `src/feishu/message-logger.ts` | ✅ 完整 |
| 卡片交互 | `src/platforms/feishu/card-builders/` | ✅ 完整 |
| Lark SDK 客户端 | `@larksuiteoapi/node-sdk` | ✅ 已集成 |

### 缺失能力（前置开发任务）

| 能力 | 描述 | 优先级 | 复杂度 |
|------|------|--------|--------|
| **群聊创建 API** | 调用飞书 API 创建群聊 | 🔴 高 | 中 |
| **群成员管理 API** | 拉用户入群、移除成员 | 🔴 高 | 中 |
| **用户状态持久化** | 存储管理员状态和日志群 ID | 🔴 高 | 低 |
| **意图识别** | 识别用户开启/关闭管理员模式的意图 | 🟡 中 | 高 |
| **群聊信息查询** | 查询用户是否已有日志群 | 🟡 中 | 低 |
| **权限管理** | 验证用户是否有权限操作 | 🟢 低 | 低 |

---

## 飞书 API 分析

### 1. 创建群聊 API

**API 端点**: `POST /im/v1/chats`

**SDK 调用方式**:
```typescript
const response = await client.im.chat.create({
  data: {
    name: 'Disclaude 日志 - 用户名',
    chat_mode: 'group',
    chat_type: 'group',
    user_id_list: ['ou_xxx'], // 初始成员
  }
});
const chatId = response.data.chat_id;
```

**权限要求**: `im:chat:write` (创建群聊)

### 2. 拉用户入群 API

**API 端点**: `POST /im/v1/chats/{chat_id}/members`

**SDK 调用方式**:
```typescript
await client.im.chatMembers.create({
  path: {
    chat_id: chatId
  },
  data: {
    member_id_type: 'open_id',
    user_id_list: ['ou_xxx']
  }
});
```

**权限要求**: `im:chat.member:write` (管理群成员)

### 3. 获取群信息 API

**API 端点**: `GET /im/v1/chats/{chat_id}`

**SDK 调用方式**:
```typescript
const response = await client.im.chat.get({
  path: {
    chat_id: chatId
  }
});
```

### 4. 用户列表查询 API

**API 端点**: `GET /im/v1/chats/{chat_id}/members`

**SDK 调用方式**:
```typescript
const response = await client.im.chatMembers.get({
  path: {
    chat_id: chatId
  },
  params: {
    member_id_type: 'open_id'
  }
});
```

---

## 前置开发任务清单

### Task 1: 群聊管理服务 (优先级: 高)

**文件**: `src/feishu/chat-manager.ts`

**功能**:
- 创建群聊
- 拉用户入群
- 查询群信息
- 查询群成员

**接口设计**:
```typescript
export interface ChatManagerConfig {
  client: lark.Client;
  logger: Logger;
}

export interface CreateGroupOptions {
  name: string;
  ownerId: string;
  initialMembers?: string[];
}

export interface ChatInfo {
  chatId: string;
  name: string;
  ownerId: string;
  memberCount: number;
}

export class ChatManager {
  constructor(config: ChatManagerConfig);

  async createGroup(options: CreateGroupOptions): Promise<string>;
  async addMembers(chatId: string, userIds: string[]): Promise<void>;
  async getChatInfo(chatId: string): Promise<ChatInfo>;
  async getMembers(chatId: string): Promise<string[]>;
}
```

**预计工作量**: 2-3 小时

### Task 2: 用户状态存储 (优先级: 高)

**文件**: `src/storage/admin-status-store.ts`

**功能**:
- 存储用户的管理员状态
- 存储用户的日志群 ID
- 支持查询和更新

**数据结构**:
```typescript
interface AdminStatus {
  userId: string;
  chatId: string;        // 用户私聊 chatId
  enabled: boolean;       // 是否开启管理员模式
  logChatId?: string;     // 日志群 chatId
  createdAt: string;
  updatedAt: string;
}
```

**存储位置**: `workspace/admin-status/{chatId}.json`

**预计工作量**: 1-2 小时

### Task 3: 意图识别服务 (优先级: 中)

**文件**: `src/intent/admin-intent-recognizer.ts`

**功能**:
- 识别用户开启管理员模式的意图
- 识别用户关闭管理员模式的意图
- 支持多种表达方式

**示例意图**:
- 开启: "我要接收所有消息"、"开启调试模式"、"我想看日志"
- 关闭: "停止接收操作消息"、"关闭调试"、"不要日志了"

**实现方式**:
- 方案 A: 关键词匹配（简单，推荐初期使用）
- 方案 B: LLM 意图识别（复杂，后期优化）

**预计工作量**: 1-2 小时（方案 A）

### Task 4: 管理员模式服务 (优先级: 高)

**文件**: `src/services/admin-mode-service.ts`

**功能**:
- 整合上述所有能力
- 提供统一的开启/关闭管理员模式接口
- 自动创建/复用日志群

**接口设计**:
```typescript
export interface AdminModeServiceConfig {
  chatManager: ChatManager;
  adminStatusStore: AdminStatusStore;
  messageSender: IMessageSender;
  logger: Logger;
}

export class AdminModeService {
  constructor(config: AdminModeServiceConfig);

  async enableAdminMode(chatId: string, userId: string): Promise<EnableResult>;
  async disableAdminMode(chatId: string, userId: string): Promise<DisableResult>;
  async getAdminStatus(chatId: string): Promise<AdminStatus | null>;
  async getLogChatId(chatId: string): Promise<string | null>;
}
```

**预计工作量**: 2-3 小时

### Task 5: 消息路由增强 (优先级: 中)

**文件**: `src/messaging/message-router.ts` (修改)

**功能**:
- 根据用户的管理员状态路由消息
- 将 DEBUG/PROGRESS/INFO 级别消息发送到日志群
- 保持 NOTICE 及以上消息发送到用户私聊

**修改点**:
```typescript
// 在 MessageRouter 中添加
async routeWithAdminMode(
  chatId: string,
  level: MessageLevel,
  content: string
): Promise<void> {
  const status = await this.adminModeService.getAdminStatus(chatId);

  if (status?.enabled && status.logChatId) {
    // DEBUG/PROGRESS/INFO 发送到日志群
    if ([MessageLevel.DEBUG, MessageLevel.PROGRESS, MessageLevel.INFO].includes(level)) {
      await this.sender.sendText(status.logChatId, content);
      return;
    }
  }

  // 默认路由逻辑
  await this.route(chatId, level, content);
}
```

**预计工作量**: 1-2 小时

---

## 实现依赖关系

```
Task 1 (群聊管理服务)
    ↓
Task 2 (用户状态存储)  ←── Task 3 (意图识别)
    ↓                       ↓
    └───────→ Task 4 (管理员模式服务) ←───────┘
                    ↓
            Task 5 (消息路由增强)
```

**建议实现顺序**:
1. Task 1 + Task 2 (可并行)
2. Task 3 (可与 Task 1/2 并行)
3. Task 4 (依赖 Task 1, 2, 3)
4. Task 5 (依赖 Task 4)

---

## 飞书应用权限要求

实现此功能需要确保飞书应用具有以下权限：

| 权限 | 描述 | 用途 |
|------|------|------|
| `im:chat` | 获取群聊信息 | 查询日志群信息 |
| `im:chat:write` | 创建群聊 | 创建日志群 |
| `im:chat.member:write` | 管理群成员 | 拉用户入群 |
| `im:message:send_as_bot` | 以应用身份发消息 | 发送消息到日志群 |

---

## 风险与注意事项

### 1. 飞书群聊限制

- 群聊名称长度限制：最长 50 字符
- 群成员数量限制：单群最多 5000 人
- 机器人必须在群内才能发送消息

### 2. 权限申请

- 飞书应用权限需要管理员审批
- 建议在开发环境先测试权限

### 3. 用户体验

- 日志群名称需要清晰标识
- 需要告知用户群的用途
- 用户退出群后不应再被拉入

### 4. 数据一致性

- 日志群被解散后的处理
- 用户状态与实际群状态的一致性

---

## 下一步行动

1. **确认飞书应用权限**：检查当前应用是否有所需权限
2. **实现 Task 1**: 群聊管理服务
3. **实现 Task 2**: 用户状态存储
4. **实现 Task 3**: 意图识别（关键词匹配版本）
5. **实现 Task 4**: 管理员模式服务
6. **实现 Task 5**: 消息路由增强
7. **集成测试**: 验证完整流程

---

## 总结

Issue #347 的实现需要 **5 个前置开发任务**，预计总工作量约 **8-12 小时**。核心前置能力是：

1. **群聊管理 API 封装** - 目前代码库完全没有此能力
2. **用户状态持久化** - 需要新增存储模块
3. **意图识别** - 需要识别用户的自然语言指令

建议按上述顺序逐步实现，每个 Task 完成后进行单元测试验证。

---

*本文档作为 Issue #347 的方案分析，为后续实现提供技术指导。*

# CommunicationNode 设计分析报告

> 文件：`src/nodes/communication-node.ts`
> 行数：801 行
> 分析日期：2026-02-27

---

## 一、职责分析

### 1.1 当前承担的职责（过多！）

| 职责 | 行数 | 说明 |
|------|------|------|
| WebSocket 服务器管理 | ~100 行 | 创建、连接处理、消息路由 |
| HTTP 服务器管理 | ~40 行 | 健康检查、文件 API |
| 执行节点注册/注销 | ~120 行 | 节点生命周期管理 |
| 聊天-节点路由 | ~80 行 | chatId 到 nodeId 的映射 |
| 通道注册和管理 | ~50 行 | 多通道生命周期 |
| 消息广播 | ~80 行 | 向所有通道发送消息 |
| 控制命令处理 | ~70 行 | reset/status/switch 等 |
| 文件存储服务 | ~40 行 | 附件存储和管理 |
| 飞书通道初始化 | ~20 行 | 硬编码的通道创建 |

**问题**：单一类承担了 **9 种职责**，严重违反单一职责原则。

---

## 二、冗余代码

### 2.1 重复的消息发送包装

```typescript
// 三个方法几乎相同，只是参数不同
async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
  await this.broadcastToChannels({
    chatId,
    type: 'text',
    text,
    threadId: threadMessageId,
  });
}

async sendCard(chatId: string, card: Record<string, unknown>, description?: string, threadMessageId?: string): Promise<void> {
  await this.broadcastToChannels({
    chatId,
    type: 'card',
    card,
    description,
    threadId: threadMessageId,
  });
}

async sendFileToUser(chatId: string, filePath: string, _threadId?: string): Promise<void> {
  await this.broadcastToChannels({
    chatId,
    type: 'file',
    filePath,
  });
}
```

**问题**：这三个方法都是 `broadcastToChannels` 的简单包装，可以考虑统一接口。

### 2.2 重复的错误处理模式

```typescript
// 模式 1：在 handleChannelMessage 中
try {
  await this.handleChannelMessage(channel.id, message);
} catch (error) {
  logger.error({ err: error, channelId: channel.id }, 'Failed to handle channel message');
}

// 模式 2：在 start() 中
for (const [channelId, channel] of this.channels) {
  try {
    await channel.start();
  } catch (error) {
    logger.error({ err: error, channelId }, 'Failed to start channel');
  }
}

// 模式 3：在 stop() 中 - 完全相同的模式
for (const [channelId, channel] of this.channels) {
  try {
    await channel.stop();
  } catch (error) {
    logger.error({ err: error, channelId }, 'Failed to stop channel');
  }
}
```

**建议**：提取通用的错误处理工具函数。

### 2.3 活跃聊天计数效率低

```typescript
// 每次调用都遍历所有 chatToNode
getExecNodes(): ExecNodeInfo[] {
  for (const [nodeId, node] of this.execNodes) {
    let activeChats = 0;
    for (const assignedNodeId of this.chatToNode.values()) {
      if (assignedNodeId === nodeId) {
        activeChats++;  // O(n*m) 复杂度
      }
    }
  }
}
```

**问题**：时间复杂度 O(n*m)，应该维护反向索引。

---

## 三、不良设计

### 3.1 构造函数中硬编码通道创建

```typescript
constructor(config: CommunicationNodeConfig) {
  // ...

  // 硬编码创建 Feishu 通道
  if (appId && appSecret) {
    const feishuChannel = new FeishuChannel({...});
    feishuChannel.initTaskFlowOrchestrator({...});
    this.registerChannel(feishuChannel);
  }

  // 硬编码创建 REST 通道
  if (config.enableRestChannel !== false) {
    const restChannel = new RestChannel({...});
    this.registerChannel(restChannel);
  }
}
```

**问题**：
- 违反开闭原则（添加新通道需要修改此类）
- 违反依赖注入原则（直接 new 具体类）
- 测试困难（无法 mock）

**建议**：使用工厂模式或完全依赖注入。

### 3.2 控制命令处理包含大量 UI 代码

```typescript
private async handleControlCommand(command: ControlCommand): Promise<ControlResponse> {
  switch (command.type) {
    case 'status': {
      const status = this.running ? 'Running' : 'Stopped';
      // ... 30 行字符串拼接 ...
      return {
        success: true,
        message: `📊 **状态**\n\n状态: ${status}\n执行节点: ${execStatus}...`,
      };
    }
    case 'list-nodes': {
      // ... 15 行字符串格式化 ...
    }
  }
}
```

**问题**：
- 业务逻辑与 UI 格式化混合
- 字符串硬编码在代码中
- 难以国际化

**建议**：提取 `CommandFormatter` 类。

### 3.3 HTTP 和 WebSocket 服务器耦合

```typescript
private async startWebSocketServer(): Promise<void> {
  // 创建 HTTP 服务器（处理文件 API 和健康检查）
  this.httpServer = http.createServer(async (req, res) => {
    // 文件 API 处理
    if (fileApiHandler && url.startsWith('/api/files')) {...}
    // 健康检查
    if (url === '/health') {...}
  });

  // WebSocket 服务器挂载到 HTTP 服务器
  this.wss = new WebSocketServer({ server: this.httpServer });

  // WebSocket 连接处理
  this.wss.on('connection', (ws, req) => {...});
}
```

**问题**：
- 方法名是 `startWebSocketServer` 但实际创建了 HTTP 服务器
- 职责混合：文件 API、健康检查、WebSocket 都在一起

**建议**：分离为 `createHttpServer()` 和 `createWebSocketServer()`。

### 3.4 消息类型处理分散

```typescript
// WebSocket 消息解析在 wss.on('message') 中
ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  if (message.type === 'register') {...}
  const feedbackMsg = message as FeedbackMessage;
  void this.handleFeedback(feedbackMsg);
});

// Feedback 处理在 handleFeedback 中
private async handleFeedback(message: FeedbackMessage): Promise<void> {
  switch (type) {
    case 'text': {...}
    case 'card': {...}
    case 'file': {...}
    case 'done': {...}
    case 'error': {...}
  }
}
```

**问题**：
- 消息类型判断分散
- 缺少统一的消息路由机制

**建议**：使用消息处理器注册模式。

### 3.5 向后兼容代码增加复杂度

```typescript
// 自动注册逻辑（1 秒超时）
const registrationTimeout = setTimeout(() => {
  if (!currentNodeId && ws.readyState === WebSocket.OPEN) {
    const autoNodeId = `exec-${Date.now()}`;
    currentNodeId = this.registerExecNode(ws, {
      type: 'register',
      nodeId: autoNodeId,
      name: 'Auto-registered Node'
    }, clientIp);
  }
}, 1000);
```

**问题**：
- 向后兼容逻辑混在主流程中
- 超时魔法数字（1000ms）

**建议**：提取为独立的 `BackwardCompatibilityHandler`。

---

## 四、重构建议

### 4.1 提取执行节点管理器

```typescript
// 新文件：src/nodes/exec-node-manager.ts
export class ExecNodeManager {
  private nodes: Map<string, ConnectedExecNode> = new Map();
  private chatToNode: Map<string, string> = new Map();
  private nodeToChats: Map<string, Set<string>> = new Map(); // 反向索引

  register(ws: WebSocket, msg: RegisterMessage, clientIp?: string): string {...}
  unregister(nodeId: string): void {...}
  getNodeForChat(chatId: string): ConnectedExecNode | undefined {...}
  switchChatNode(chatId: string, nodeId: string): boolean {...}
  getStats(): ExecNodeInfo[] {...}
}
```

### 4.2 提取控制命令处理器

```typescript
// 新文件：src/nodes/control-command-handler.ts
export class ControlCommandHandler {
  constructor(
    private execNodeManager: ExecNodeManager,
    private channelManager: ChannelManager
  ) {}

  async handle(command: ControlCommand): Promise<ControlResponse> {...}
}
```

### 4.3 提取通道管理器

```typescript
// 新文件：src/nodes/channel-manager.ts
export class ChannelManager {
  private channels: Map<string, IChannel> = new Map();

  register(channel: IChannel): void {...}
  async broadcast(message: OutgoingMessage): Promise<void> {...}
  async startAll(): Promise<void> {...}
  async stopAll(): Promise<void> {...}
}
```

### 4.4 重构后的 CommunicationNode

```typescript
// 重构后约 200 行
export class CommunicationNode extends EventEmitter {
  private execNodeManager: ExecNodeManager;
  private channelManager: ChannelManager;
  private commandHandler: ControlCommandHandler;
  private httpServer?: HttpServerWrapper;
  private wsServer?: WebSocketServerWrapper;

  constructor(config: CommunicationNodeConfig) {
    this.execNodeManager = new ExecNodeManager();
    this.channelManager = new ChannelManager();
    this.commandHandler = new ControlCommandHandler(
      this.execNodeManager,
      this.channelManager
    );
  }

  async start(): Promise<void> {
    await this.channelManager.startAll();
    this.wsServer = await this.createWebSocketServer();
  }
}
```

---

## 五、优先级建议

| 优先级 | 重构项 | 收益 | 风险 |
|--------|--------|------|------|
| **P0** | 提取 ExecNodeManager | 降低 30% 复杂度 | 低 |
| **P0** | 提取 ChannelManager | 降低 15% 复杂度 | 低 |
| **P1** | 分离 HTTP/WebSocket | 职责清晰 | 中 |
| **P1** | 移除硬编码通道创建 | 提高可扩展性 | 中 |
| **P2** | 优化活跃聊天计数 | 性能提升 | 低 |
| **P2** | 提取命令格式化 | 可维护性 | 低 |

---

## 六、总结

`CommunicationNode` 类存在以下主要问题：

1. **职责过多**（9 种）- 违反 SRP
2. **硬编码依赖** - 违反 OCP 和 DIP
3. **UI 逻辑混合** - 违反关注点分离
4. **效率问题** - O(n*m) 查询
5. **向后兼容代码** - 增加维护负担

**建议**：按优先级逐步重构，先提取 `ExecNodeManager` 和 `ChannelManager`，可将代码量从 801 行降到约 400 行。

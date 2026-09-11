# Unified ProjectContext Design Proposal

> **状态**: Final
> **日期**: 2026-04-06
> **目标**: 统一的 ProjectContext 系统 — per-chatId 的 Agent 上下文切换，基于模板实例化
> **迁移计划**: [project-context-migration.md](./project-context-migration.md)
> **Agent 集成设计**: 详见 [§5 Agent 生命周期与 Project 切换](#5-agent-生命周期与-project-切换)

---

## 1. 核心概念

**ProjectContext** = 一个命名的 Agent 上下文，捆绑了 1 个维度：

```
ProjectContext {
  工作空间 → workingDir（Agent 在其中自行发现 CLAUDE.md）
}
```

> **极简理念**: disclaude 只做一件事——**切换 Agent 的 cwd**。模板实例化时，系统从 package 内置的模板目录复制 CLAUDE.md 到实例的 workingDir，Agent 框架自然发现。**不存在其他注入方式**。其余一切（知识发现、状态管理、Skill 过滤、环境变量）均由 Agent 框架和外部配置处理。

### 两层架构: 模板 (Template) + 实例 (Instance)

```
模板 (Template)              实例 (Instance)               绑定 (Binding)
┌─────────────┐          ┌──────────────────┐          ┌──────────────┐
│  research   │  ──实例化→ │ my-research      │  ←绑定── │  chatId: A   │
│  (模板)     │          │ (独立 workingDir) │          │              │
│             │  ──实例化→ │ deep-dive        │  ←绑定── │  chatId: B   │
│             │          │ (独立 workingDir) │          │              │
└─────────────┘          └──────────────────┘          └──────────────┘
                                                    (A 和 B 可共享实例)

┌─────────────┐
│  default    │  ← 默认，所有未绑定的 chatId 使用，workingDir = workspace
│  (隐式内置) │
└─────────────┘
```

### 关键洞察

- 「Default 日常模式」= 名为 `default` 的 project，workingDir 为 workspace 根目录，始终隐式可用
- 「Research 模式」= 名为 `research` 的**模板**（CLAUDE.md 内置于 package），用户创建实例时指定名称
- **切换模式 = 切换 project，不需要独立系统**
- **模板不是 project，模板是创建 project 的蓝图**
- **模板 CLAUDE.md 存放在 package 内，实例化时复制到实例 workingDir**
- **实例名由用户显式指定，全局唯一，可跨 chatId 共享**
- **实例 = 模板的一次快照，实例创建后与模板独立**

---

## 2. 数据模型

```typescript
/**
 * 项目模板 —— 定义创建 project 的蓝图
 *
 * 模板 CLAUDE.md 源文件: {packageDir}/templates/{name}/CLAUDE.md
 * 实例 workingDir: {workspace}/projects/{name}/
 *
 * 注意: 只有在 projectTemplates 配置中列出的模板才可用。
 */
interface ProjectTemplate {
  /** 模板名称 */
  name: string;

  /** 显示名称 */
  displayName?: string;

  /** 描述 */
  description?: string;
}

/**
 * 统一 project 配置（实例）
 *
 * 实例来源:
 * 1. default: 隐式内置，workingDir = workspace 根目录
 * 2. 其他: 基于 projectTemplates 实例化，用户指定名称
 *
 * 注意:
 * CLAUDE.md 仅在模板实例化时从 package 内复制到 workingDir，不存在其他注入方式。
 * chatId → name 的绑定关系由 chatProjectMap 管理，不存储在实例上。
 */
interface ProjectContextConfig {
  /** 实例名称（用户创建时显式指定，全局唯一） */
  name: string;

  /** 来源模板名（实例化时设置） */
  templateName?: string;

  /** 实例的工作目录 */
  workingDir: string;
}

/**
 * 实例详情（用于 listInstances 返回值）
 *
 * 与 ProjectContextConfig 的区别：包含绑定关系和元数据，
 * 不包含 default（default 是隐式内置的，不在列表中显示）。
 */
interface InstanceInfo {
  /** 实例名称 */
  name: string;

  /** 来源模板名 */
  templateName: string;

  /** 绑定的所有 chatId（支持共享） */
  chatIds: string[];

  /** 实例的工作目录 */
  workingDir: string;

  /** 创建时间 */
  createdAt: string;
}
```

---

## 3. 配置文件设计

```yaml
# disclaude.config.yaml

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 项目模板 —— 控制哪些模板可用
# CLAUDE.md 源文件: {packageDir}/templates/{name}/CLAUDE.md（内置）
# 实例 workingDir: {workspace}/projects/{name}/（约定）
#
# 只有列在此处的模板才可用，未列出的内置模板不可用。
# default project 始终隐式可用，无需配置。
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

projectTemplates:
  # Research 模板
  research:
    displayName: "研究模式"
    description: "专注研究的独立空间"

  # 读书助手模板
  book-reader:
    displayName: "读书助手"
```

---

## 4. API 设计

### 4.1 ProjectManager 核心模块

```typescript
// packages/core/src/project/project-manager.ts

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

class ProjectManager {
  private templates: Map<string, ProjectTemplate>;
  private projects: Map<string, ProjectContextConfig>;
  private chatProjectMap: Map<string, string>; // chatId → name

  /** 初始化：加载模板（从 package 内置，与配置取交集）、已有实例和绑定关系 */
  init(config: DisclaudeConfig): void; // 失败时 throw

  /** 获取当前 chatId 绑定的 project（未绑定时返回 default） */
  getActive(chatId: string): ProjectContextConfig;

  /**
   * 创建新实例并绑定到 chatId
   * - 从模板创建实例，复制 CLAUDE.md 到 workingDir
   * - 失败场景: 模板不存在 / 实例名已存在 / name 为 "default"（保留名） / CLAUDE.md 复制失败
   */
  create(chatId: string, templateName: string, name: string): Result<ProjectContextConfig>;

  /**
   * 绑定到已有实例
   * - 失败场景: 实例不存在 / name 为 "default"（保留名，应使用 reset）
   * 多个 chatId 可绑定到同一实例（共享工作空间）
   */
  use(chatId: string, name: string): Result<ProjectContextConfig>;

  /** 重置到 default project（已处于 default 时静默 no-op） */
  reset(chatId: string): Result<ProjectContextConfig>;

  /** 列出所有可用模板 */
  listTemplates(): ProjectTemplate[];

  /** 列出所有实例（含绑定关系），不包含 default */
  listInstances(): InstanceInfo[];

  // ---- 内部方法 ----

  /** 从模板创建实例（含 CLAUDE.md 复制） */
  private instantiateFromTemplate(
    templateName: string,
    name: string,
  ): Result<ProjectContextConfig>;

  /** 从 package 内置模板复制 CLAUDE.md 到实例 workingDir */
  private copyClaudeMd(
    templateName: string,
    targetDir: string,
  ): Result<void>;
}
```

### 4.2 与现有模块的集成点

```
ProjectManager
  │
  ├──→ ChatAgent (CwdProvider 注入)   §5 详细设计
  │     startAgentLoop() → createSdkOptions({ cwd: project.workingDir })
  │
  ├──→ PrimaryAgentPool           创建 Agent 时注入 CwdProvider
  │     getOrCreateChatAgent() → agent.setCwdProvider(...)
  │
  └──→ Control Handler            处理 /project 命令 + 触发 Session Reset
        ControlHandlerContext.projectManager
        新增: /project list|create|use|info|reset
```

#### 集成改动清单

| 文件 | 改动内容 | 行数 |
|------|----------|------|
| `chat-agent/index.ts` | 新增 `cwdProvider` 属性 + `startAgentLoop` 注入 cwd | +5 |
| `primary-agent-pool.ts` | 创建 Agent 时注入 cwdProvider | +3 |
| `control/types.ts` | ControlHandlerContext 新增 `projectManager` | +3 |
| `control/commands/project.ts` | 新增 /project 命令处理 | ~60 |
| **总计** | | **~70** |

> **注意**: 不需要集成 MessageBuilder、Skill Registry 或 Runtime Env。Agent 框架会自动发现 workingDir 中的 CLAUDE.md，Skill 和环境变量由框架/外部配置管理。所有 project 都有 `workingDir`（`default` 为 workspace 根目录），无需 fallback 逻辑。
>
> **核心发现**: 现有 `BaseAgent.createSdkOptions(extra: SdkOptionsExtra)` 已支持 `extra.cwd` 参数（`cwd: extra.cwd ?? this.getWorkspaceDir()`），且 `SdkOptionsExtra` 接口已定义 `cwd?: string` 字段。无需修改 BaseAgent 或 SDK 层代码。

### 4.3 命令设计

```
# 核心命令
/project list                          → 列出所有可用模板 + 已创建实例
/project create <template> <name>       → 从模板创建新实例
/project use <name>                    → 绑定到已有实例
/project info                          → 查看当前 project 详情（调用 getActive()）
/project reset                          → 重置为 default
```

> **设计原则**: `create` 创建新实例（名称冲突时报错），`use` 绑定已有实例。`/project list` 同时显示可用模板和已创建实例。同一实例可被多个 chatId 绑定（共享工作空间）。

---

## 5. Agent 生命周期与 Project 切换

> **核心决策**: Project 切换时**不销毁 Agent 实例**，而是 **Reset Session + 重新注入 cwd**。

### 5.1 现有调用链分析

```
User Message
  → createDefaultMessageHandler()                      // channel-handlers.ts:175
    → agentPool.getOrCreateChatAgent(chatId, callbacks) // primary-agent-pool.ts:57
    → agent.processMessage(chatId, text, ...)           // chat-agent/index.ts:512
      → if (!isSessionActive) startAgentLoop()          // chat-agent/index.ts:539
        → createSdkOptions({ disallowedTools, mcpServers })  // chat-agent/index.ts:689
          → cwd: extra.cwd ?? this.getWorkspaceDir()          // base-agent.ts:157
        → createQueryStream(channel.generator(), sdkOptions) // chat-agent/index.ts:703
          → SDK 启动，发现 cwd 中的 CLAUDE.md
```

**关键特征**:

| 特性 | 说明 |
|------|------|
| `SdkOptionsExtra.cwd` | ✅ 已支持，`createSdkOptions` 有 `extra.cwd` 参数 |
| `startAgentLoop` 时机 | 仅在 `!isSessionActive` 时调用（每个 Session 一次） |
| Session 生命周期 | **持久流式**: `channel.push()` 持续喂消息，直到 `channel.close()` |
| `reset()` 效果 | 关闭 channel + queryHandle → `isSessionActive = false` |
| 下一条消息 | 触发新的 `startAgentLoop()` → 新的 `createSdkOptions()` |

### 5.2 集成方案: CwdProvider 注入 + Session Reset

#### 核心思路

1. **CwdProvider 回调**: ChatAgent 通过回调函数动态查询当前 project 的 workingDir，无需直接依赖 ProjectManager
2. **Session Reset**: Project 切换时调用 `agentPool.reset(chatId)` 关闭当前 Session
3. **自动重建**: 下一条消息触发新的 `startAgentLoop()`，通过 CwdProvider 获取新 cwd

#### 代码改动

**① 定义 CwdProvider 接口**

```typescript
// packages/core/src/project/types.ts (新增)
export type CwdProvider = (chatId: string) => string | undefined;
```

**② ChatAgent 注入 CwdProvider**

```typescript
// packages/worker-node/src/agents/chat-agent/index.ts
class ChatAgent extends BaseAgent {
  private cwdProvider?: CwdProvider;  // 新增

  setCwdProvider(provider: CwdProvider): void {  // 新增
    this.cwdProvider = provider;
  }
}
```

**③ startAgentLoop 注入 cwd（核心改动，仅 +2 行）**

```typescript
// chat-agent/index.ts — startAgentLoop() 中，第 688-692 行附近

// === 改动前 ===
const sdkOptions = this.createSdkOptions({
  disallowedTools: ['EnterPlanMode'],
  mcpServers,
});

// === 改动后 ===
const projectCwd = this.cwdProvider?.(this.boundChatId);  // 👈 新增
const sdkOptions = this.createSdkOptions({
  disallowedTools: ['EnterPlanMode'],
  mcpServers,
  ...(projectCwd && { cwd: projectCwd }),  // 👈 新增
});
```

**④ PrimaryAgentPool 注入**

```typescript
// packages/primary-node/src/primary-agent-pool.ts
class PrimaryAgentPool {
  private projectManager?: ProjectManager;  // 新增

  setProjectManager(pm: ProjectManager): void {  // 新增
    this.projectManager = pm;
  }

  getOrCreateChatAgent(chatId: string, callbacks: ChatAgentCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = AgentFactory.createChatAgent('chat-agent', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
      });
      // 注入 cwdProvider 👇
      if (this.projectManager) {
        agent.setCwdProvider(
          (id) => this.projectManager!.getActive(id).workingDir
        );
      }
      this.agents.set(chatId, agent);
    }
    return agent;
  }
}
```

**⑤ ControlHandlerContext 扩展**

```typescript
// packages/core/src/control/types.ts
export interface ControlHandlerContext {
  agentPool: { reset(chatId: string): void; stop(chatId: string): boolean };
  node: { /* ... */ };
  passiveMode?: { /* ... */ };
  logger?: Logger;

  // 👇 新增
  projectManager?: {
    getActive(chatId: string): ProjectContextConfig;
    create(chatId: string, templateName: string, name: string): Result<ProjectContextConfig>;
    use(chatId: string, name: string): Result<ProjectContextConfig>;
    reset(chatId: string): Result<ProjectContextConfig>;
    listTemplates(): ProjectTemplate[];
    listInstances(): InstanceInfo[];
  };
}
```

**⑥ /project 命令处理（含 Session Reset）**

```typescript
// packages/core/src/control/commands/project.ts
export async function handleProject(
  command: ControlCommand,
  context: ControlHandlerContext,
): Promise<ControlResponse> {
  const { chatId, data } = command;
  const pm = context.projectManager;
  if (!pm) return { success: false, message: 'ProjectManager 未初始化' };

  const args = (data?.args as string[]) || [];
  const sub = args[0];

  switch (sub) {
    case 'use': {
      if (!args[1]) return { success: false, message: '用法: /project use <name>' };
      const result = pm.use(chatId, args[1]);
      if (result.ok) {
        context.agentPool.reset(chatId);  // 👈 关键：重置 Session
        return { success: true, message: `已切换到 ${args[1]} ✅` };
      }
      return { success: false, message: result.error };
    }
    case 'create': {
      if (!args[1] || !args[2]) return { success: false, message: '用法: /project create <template> <name>' };
      const result = pm.create(chatId, args[1], args[2]);
      if (result.ok) {
        context.agentPool.reset(chatId);  // 👈 创建后也重置
        return { success: true, message: `已创建 ${args[2]} 并切换 ✅` };
      }
      return { success: false, message: result.error };
    }
    case 'reset': {
      const result = pm.reset(chatId);
      if (result.ok) {
        context.agentPool.reset(chatId);  // 👈 双重 reset
        return { success: true, message: '已重置为默认项目 ✅' };
      }
      return { success: false, message: result.error };
    }
    case 'list': { /* ... */ }
    case 'info': { /* ... */ }
    default:
      return { success: false, message: `未知子命令: ${sub}。可用: list|create|use|info|reset` };
  }
}
```

### 5.3 完整时序: /project use my-research

```
用户: /project use my-research
  │
  ├─→ ControlHandler.handleProject()
  │     ├─→ ProjectManager.use(chatId, 'my-research')
  │     │     └─→ 更新 chatProjectMap: chatId → 'my-research'
  │     ├─→ agentPool.reset(chatId)                     ← Session Reset
  │     │     └─→ ChatAgent.reset()
  │     │           ├─→ isSessionActive = false
  │     │           ├─→ channel.close()
  │     │           ├─→ queryHandle.close()
  │     │           └─→ 清空 conversationContext
  │     └─→ 返回 "已切换到 my-research ✅"
  │
用户: 你好，帮我研究一下 X
  │
  ├─→ createDefaultMessageHandler()
  │     ├─→ agentPool.getOrCreateChatAgent(chatId, callbacks)
  │     │     └─→ 返回已有 ChatAgent（未销毁，只是 Session 被重置）
  │     └─→ agent.processMessage(chatId, '帮我研究一下 X', ...)
  │           ├─→ !isSessionActive → startAgentLoop()
  │           │     ├─→ cwdProvider(chatId)
  │           │     │     └─→ ProjectManager.getActive(chatId).workingDir
  │           │     │           └─→ '.../projects/my-research/'  👈 新 cwd
  │           │     ├─→ createSdkOptions({ cwd: '.../projects/my-research/' })
  │           │     ├─→ createQueryStream(channel.generator(), sdkOptions)
  │           │     │     └─→ SDK 启动，cwd = '.../projects/my-research/'
  │           │     │           └─→ Claude Code 发现 CLAUDE.md
  │           │     │                 └─→ 加载 Research 模式指令
  │           │     └─→ isSessionActive = true
  │           └─→ channel.push(userMessage) → 消息进入 SDK 流
  │
  └─→ Agent 以 Research 模式响应
```

### 5.4 边界情况

| 场景 | 行为 | 说明 |
|------|------|------|
| Default Project 的 cwd | `cwdProvider` 返回 `undefined` → 走 `getWorkspaceDir()` | 零改动，自然兼容 |
| Agent 实例不销毁 | Project 切换只 reset Session，不 dispose Agent | Agent 实例（callbacks、messageBuilder）保持不变，开销极低 |
| 切换时 Agent 正在处理消息 | `ChatAgent.reset()` 同步关闭 channel + queryHandle | 与 `/reset` 行为一致，用户可能看到不完整回复 |
| 共享实例并发安全 | 两个 chatId → 两个独立 ChatAgent → 各自独立的 SDK 子进程 | 文件写入冲突由用户自行管理 |

---

## 6. 运行时行为

### 6.1 Project 创建流程（含模板实例化）

```
用户发送: /project create research my-research

1. ProjectManager.create(chatId, 'research', 'my-research')
   ├── 查找 'research' → 发现是可用模板
   │   └── 不存在 → 返回 { ok: false, error: "模板不存在" }
   ├── 检查 'my-research' 是否为保留名
   │   └── 是 "default" → 返回 { ok: false, error: "\"default\" 为保留名" }
   ├── 检查 'my-research' 是否已存在
   │   ├── 已存在 → 返回 { ok: false, error: "实例名已存在，请使用 /project use 绑定" }
   │   └── 不存在 → 实例化:
   │       ├── 生成 workingDir: "{workspace}/projects/my-research/"（约定）
   │       ├── 创建 workingDir 目录
   │       ├── 从 {packageDir}/templates/research/CLAUDE.md 复制到 workingDir/CLAUDE.md  ← 关键步骤
   │       │   └── 失败 → 清理已创建的 workingDir（回滚）
   │       └── 注册实例到 projects Map
   ├── 记录 chatId → name 映射
   └── 返回 { ok: true, data: ProjectContextConfig }

2. 下一条消息进入时
   ├── ProjectManager.getActive(chatId) → 返回实例配置
   ├── Agent Session 启动时（startAgentLoop，见 §5）
   │   └── cwd = 实例的 workingDir（通过 CwdProvider 动态获取，已含 CLAUDE.md）
   │
   └── Agent 框架在 cwd 中发现 CLAUDE.md，自行加载指令
       Agent 在 workingDir 中自主管理文件和状态
```

### 6.2 CLAUDE.md 实例化策略

```
约定路径:
  模板 CLAUDE.md 源: {packageDir}/templates/{templateName}/CLAUDE.md
  实例 workingDir:   {workspace}/projects/{name}/

实例化时:
  source: {packageDir}/templates/research/CLAUDE.md
  target: {workspace}/projects/my-research/CLAUDE.md
  action: 复制（实例是模板的快照，创建后独立）

注意:
  - 模板更新不影响已有实例（实例是创建时的快照）
  - 如需同步模板更新：删除实例目录 + 清理 projects.json 中对应条目，然后重新 /project create
  - 实例的 workingDir 中 Agent 创建的其他文件不受影响
  - 不提供 /project delete 命令，实例删除为手动操作（rm 目录 + 清理 projects.json）
```

### 6.3 多 chatId 隔离与共享

- 每个 chatId 可以独立切换 project
- 默认所有 chatId 使用 `default` project（workingDir = workspace 根目录）
- 模板 project 实例化后可被多个 chatId 绑定（共享工作空间）
- Project 切换仅影响对应 chatId 的绑定
- 存储位置: `{workspace}/.disclaude/projects.json`（实例数据 + chatId → name 映射，单文件）
- 持久化时机: 每次 mutation（create/use/reset）后立即写入 `projects.json`
- 实例目录永久保留，不做自动清理

---

## 7. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Project 切换中断进行中的 Agent | 中 | 中 | `ChatAgent.reset()` 同步关闭 channel/queryHandle，与 `/reset` 行为一致 |
| 实例 CLAUDE.md 与模板不同步 | 低 | 低 | 删除实例后重新 create；属于预期行为 |
| 共享实例并发写入冲突 | 低 | 中 | 两个 chatId → 两个独立 ChatAgent → 各自独立的 SDK 子进程，仅文件层可能冲突 |
| projects.json 写入损坏 | 低 | 高 | 使用 write-then-rename 模式（先写 `.tmp`，再 `rename`）保证原子性 |

---

## 8. 成功指标

- [ ] 零配置时行为与当前完全一致（`default` 始终可用，`cwdProvider` 返回 `undefined` 走 `getWorkspaceDir()`）
- [ ] 新增模板不需要修改核心代码（package 内添加 CLAUDE.md + 配置元数据）
- [ ] `/project create research my-research` 创建实例、绑定、并 reset Session
- [ ] `/project use my-research` 绑定到已有实例并 reset Session
- [ ] `/project list` 同时显示可用模板和已创建实例
- [ ] `/project reset` 重置为 default 并 reset Session
- [ ] Project 切换后，下一条消息自动使用新 cwd（`startAgentLoop` 通过 CwdProvider 获取）
- [ ] Project 切换后，SDK 在新 cwd 中发现 CLAUDE.md 并加载项目指令
- [ ] Agent 实例不被销毁（只 reset Session，callbacks/messageBuilder 保持不变）
- [ ] 实例化后 workingDir 中自动包含 CLAUDE.md

---

## 附录: 文件结构规划

```
packages/core/
├── src/
│   ├── project/                    # 新模块
│   │   ├── index.ts
│   │   ├── project-manager.ts      # ProjectManager 核心
│   │   ├── project-manager.test.ts
│   │   └── types.ts                # ProjectContextConfig, ProjectTemplate, InstanceInfo, CwdProvider
│   │
│   ├── config/
│   │   └── types.ts                # 新增 projectTemplates 配置段
│   │
│   ├── agents/
│   │   ├── base-agent.ts           # 无需改动（createSdkOptions 已支持 extra.cwd）
│   │   └── message-builder/        # 无需改动（CLAUDE.md 由框架发现）
│   │
│   └── control/
│       ├── types.ts                # ControlHandlerContext 新增 projectManager 字段
│       └── commands/
│           └── project.ts          # /project 命令处理（含 Session Reset）
│
packages/worker-node/
└── src/agents/chat-agent/
    └── index.ts                    # 新增 cwdProvider 属性 + startAgentLoop 注入 cwd (+5 行)

packages/primary-node/
└── src/
    └── primary-agent-pool.ts       # 新增 setProjectManager + getOrCreateChatAgent 注入 (+3 行)

packages/core/
└── templates/                      # 内置模板 CLAUDE.md
    ├── research/
    │   └── CLAUDE.md
    └── book-reader/
        └── CLAUDE.md
```

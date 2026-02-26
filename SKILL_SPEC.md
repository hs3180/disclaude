# Claude Code Skills 开发指南

> **版本**: 1.0.0
> **更新日期**: 2025-01-27
> **基于**: [Claude Code 官方文档](https://code.claude.com/docs/en/skills)

## 简介

Claude Code Skills 是基于 **Agent Skills 开放标准** 的扩展机制，允许自定义 Claude 的行为和能力。通过创建 `SKILL.md` 文件，可以添加新的 slash 命令、注入领域知识、或自动化复杂工作流程。

### 快速开始

```bash
# 创建个人技能（适用于所有项目）
mkdir -p ~/.claude/skills/my-skill

# 创建项目技能（仅适用于当前项目）
mkdir -p .claude/skills/my-skill
```

---

## 目录

1. [基础结构](#1-基础结构)
2. [Frontmatter 配置](#2-frontmatter-配置)
3. [技能类型](#3-技能类型)
4. [最佳实践](#4-最佳实践)
5. [高级特性](#5-高级特性)
6. [实战示例](#6-实战示例)
7. [常见问题](#7-常见问题)

---

## 1. 基础结构

每个技能由两部分组成：**YAML frontmatter**（元数据）和 **Markdown 内容**（指令）。

```markdown
---
name: my-skill
description: 技能功能的简短描述
---

# 技能标题

这里是 Claude 在调用此技能时需要遵循的具体指令。
```

### 目录结构

```
my-skill/
├── SKILL.md          # 必需：主指令文件
├── reference.md      # 可选：详细参考文档
├── examples.md       # 可选：使用示例
└── scripts/          # 可选：可执行脚本
    └── helper.py     # Claude 可调用的工具脚本
```

> **提示**: 保持 `SKILL.md` 在 500 行以内，将详细内容移至支持文件以优化上下文加载。

---

## 2. Frontmatter 配置

Frontmatter 是技能的配置元数据，位于 `SKILL.md` 顶部的 `---` 分隔符之间。

### 核心字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 否 | 技能名称，作为 `/slash-command` 使用。小写字母、数字、连字符，最多 64 字符 |
| `description` | string | 是 | 技能功能描述。Claude 据此判断何时自动加载技能 |
| `argument-hint` | string | 否 | 参数提示，如 `[issue-number]` 或 `[file] [format]` |
| `version` | string | 否 | 技能版本号 |

### 调用控制

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `disable-model-invocation` | boolean | `false` | 设为 `true` 仅允许手动触发（`/skill-name`），Claude 不会自动调用 |
| `user-invocable` | boolean | `true` | 设为 `false` 从 `/` 菜单隐藏，仅供 Claude 自动调用 |

**调用权限矩阵**：

| 配置 | 用户可调用 | Claude 可调用 | 上下文加载时机 |
|------|-----------|---------------|---------------|
| 默认 | 是 | 是 | 描述常驻，完整内容在调用时加载 |
| `disable-model-invocation: true` | 是 | 否 | 仅在用户手动调用时加载 |
| `user-invocable: false` | 否 | 是 | 描述常驻，完整内容在调用时加载 |

### 工具限制

| 字段 | 类型 | 说明 |
|------|------|------|
| `allowed-tools` | string | 逗号分隔的工具名称列表，激活时无需额外权限 |

> **重要**：使用逗号分隔的字符串格式，而非 YAML 数组。

```yaml
# 正确格式
allowed-tools: Read, Write, Edit, Bash, Task

# 错误格式
allowed-tools: ["Read", "Write", "Edit"]  # 非标准格式
tools: ["Read", "Write"]                  # 字段名错误
```

### 执行环境

| 字段 | 类型 | 说明 |
|------|------|------|
| `context` | string | 设为 `fork` 在隔离的子代理中运行 |
| `agent` | string | 子代理类型：`Explore`、`Plan`、`general-purpose` 或自定义代理 |
| `model` | string | 技能激活时使用的模型 |
| `hooks` | object | 技能生命周期钩子配置 |

---

## 3. 技能类型

### 3.1 参考内容技能（Reference Content）

**用途**：注入领域知识、编码规范、API 约定等背景信息。

**特点**：
- 在对话中内联运行，与用户上下文融合
- Claude 根据描述自动决定何时加载
- 不适合添加 `disable-model-invocation`

**示例**：API 设计规范

```yaml
---
name: api-conventions
description: RESTful API 设计规范和约定
---

编写 API 端点时遵循以下原则：

- 使用 RESTful 命名约定（如 `GET /users/:id`）
- 返回统一的错误响应格式：`{ error: string, code: number }`
- 所有端点包含请求参数验证
- 使用适当的 HTTP 状态码（200、201、400、401、404、500 等）
- 在代码注释中记录每个端点的用途和参数
```

### 3.2 任务内容技能（Task Content）

**用途**：执行特定操作的逐步指令，如部署、提交、代码生成。

**特点**：
- 通常通过 `/skill-name` 直接调用
- **推荐**添加 `disable-model-invocation: true` 防止意外触发
- 包含明确的执行步骤和验收标准

**示例**：部署工作流

```yaml
---
name: deploy
description: 将应用部署到生产环境
disable-model-invocation: true
---

执行部署流程：

1. **运行测试**: `npm test`
2. **构建应用**: `npm run build`
3. **推送到生产**: `git push production main`
4. **验证部署**: 访问 https://production.example.com

确认每个步骤成功后再继续下一步。
```

### 3.3 交互式任务技能

**用途**：需要用户输入或确认的复杂任务。

**特点**：
- 使用参数占位符接收用户输入
- 可通过位置参数或命名参数传递数据

**示例**：GitHub Issue 修复

```yaml
---
name: fix-issue
description: 修复 GitHub issue
argument-hint: [issue-number]
disable-model-invocation: true
---

修复 GitHub issue #$ARGUMENTS：

1. 使用 `gh issue view $ARGUMENTS` 查看 issue 详情
2. 理解需求和验收标准
3. 实施修复并编写测试
4. 创建提交，引用 issue：`Fixes #$ARGUMENTS`
```

使用：`/fix-issue 123`

---

## 4. 最佳实践

### 4.1 描述编写技巧

好的描述是技能被正确发现和使用的关键。

**好的描述**：
```yaml
description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
```

**不好的描述**：
```yaml
description: 代码解释  # 太简短，缺少上下文
description: This skill explains code in a very detailed manner with lots of examples...  # 太冗长
```

**要点**：
- 包含关键词（用户会搜索的词）
- 说明使用场景（何时使用）
- 保持在一两句话内

### 4.2 参数处理

使用字符串替换变量让技能更灵活：

| 变量 | 说明 | 示例 |
|------|------|------|
| `$ARGUMENTS` | 所有参数 | `/skill foo bar` → `$ARGUMENTS` = `foo bar` |
| `$ARGUMENTS[N]` | 位置参数（0-based） | `$ARGUMENTS[0]` = `foo`, `$ARGUMENTS[1]` = `bar` |
| `$N` | 位置参数简写 | `$0` = `foo`, `$1` = `bar` |
| `${CLAUDE_SESSION_ID}` | 当前会话 ID | 用于日志文件命名 |

**示例**：组件迁移技能

```yaml
---
name: migrate-component
description: 将组件从一个框架迁移到另一个框架
argument-hint: [component] [from-framework] [to-framework]
---

将组件 **$0** 从 **$1** 迁移到 **$2**。

步骤：
1. 使用 Read 工具查看 $1 组件的实现
2. 根据 $2 的最佳实践重写组件
3. 保留所有现有功能和测试
4. 更新导入语句和依赖
```

使用：`/migrate-component SearchBar React Vue`

### 4.3 技能存储位置

按优先级排序（高到低）：

```
Enterprise（企业级）> Personal（个人）> Project（项目）> Plugin（插件）
```

| 位置 | 路径 | 作用域 |
|------|------|--------|
| 企业级 | 通过 managed settings 配置 | 组织内所有用户 |
| 个人 | `~/.claude/skills/<name>/SKILL.md` | 你的所有项目 |
| 项目 | `.claude/skills/<name>/SKILL.md` | 当前项目 |
| 插件 | `<plugin>/skills/<name>/SKILL.md` | 插件启用处 |

**选择建议**：
- **通用技能**（如 git 约定、代码规范）→ 个人技能
- **项目特定**（如项目构建流程、API 文档）→ 项目技能
- **团队共享**（如部署流程、安全规范）→ 企业级或项目技能

### 4.4 工具限制

限制可用工具可以提高安全性和可控性。

**只读模式**：
```yaml
allowed-tools: Read, Grep, Glob
```

**代码审查专用**：
```yaml
allowed-tools: Read, Grep, Glob, Bash(git:*)
```

**工具权限语法**：
- `ToolName` - 完全匹配
- `ToolName(prefix:*)` - 前缀匹配（如 `Bash(git:*)` 允许所有 git 命令）

### 4.5 内容组织

**主文件（SKILL.md）**：
- 保持简洁（500 行以内）
- 包含核心指令和流程
- 引用支持文件

**支持文件结构**：
```markdown
## 在 SKILL.md 中

## 参考资料
- 详细的 API 文档：[reference.md](reference.md)
- 使用示例：[examples.md](examples.md)
- 相关脚本：[scripts/](scripts/)
```

---

## 5. 高级特性

### 5.1 动态上下文注入

使用 `!`command`` 语法在技能加载时执行 shell 命令，将输出注入到技能内容中。

**使用场景**：
- 获取当前 git 状态
- 读取环境变量
- 从 CLI 工具获取实时数据

**示例**：PR 总结技能

```yaml
---
name: pr-summary
description: 总结当前拉取请求的更改
context: fork
agent: Explore
allowed-tools: Bash(gh:*)
---

## 拉取请求信息

**Diff**：
!`gh pr diff`

**Comments**：
!`gh pr view --comments`

**Changed Files**：
!`gh pr diff --name-only`

## 你的任务
分析以上信息，生成一份简洁的 PR 总结，包括：
1. 主要更改内容
2. 影响范围
3. 潜在风险点
4. 测试建议
```

**执行流程**：
1. 用户调用 `/pr-summary`
2. Claude Code 执行 `!` 包裹的命令
3. 命令输出替换占位符
4. 渲染后的完整内容发送给 Claude

### 5.2 子代理隔离

通过 `context: fork` 在隔离环境中运行技能，避免污染主对话上下文。

**适用场景**：
- 需要大量文件读取的研究任务
- 可能产生大量中间结果的计算
- 需要特定工具权限的操作

**可用代理类型**：

| 代理 | 用途 | 工具特点 |
|------|------|----------|
| `Explore` | 代码库探索、分析 | 只读工具（Read、Grep、Glob） |
| `Plan` | 架构设计、实现计划 | 规划专用工具 |
| `general-purpose` | 通用任务 | 完整工具集 |
| 自定义 | 特定领域 | 自定义配置 |

> **注意**：`context: fork` 仅适用于有明确任务的技能。如果技能只包含指南而无具体任务，子代理会收到指南但无法执行。

### 5.3 生成可视化输出

技能可以捆绑脚本生成交互式 HTML、图表等可视化内容。

**其他可视化类型**：
- 依赖关系图
- 测试覆盖率热图
- API 文档生成
- 数据库 Schema 可视化
- 性能分析报告

### 5.4 钩子（Hooks）

在技能生命周期中自动执行操作。

**示例**：部署前验证

```yaml
---
name: deploy
description: 部署到生产环境
hooks:
  beforeDeploy:
    - run: npm test
      description: 运行测试套件
    - run: npm run lint
      description: 代码质量检查
  afterDeploy:
    - run: curl -f https://production.example.com/health || exit 1
      description: 健康检查
---

部署流程...
```

---

## 6. 实战示例

### 示例 1：代码审查技能

```yaml
---
name: review-code
description: 审查代码更改，检查质量、安全性和最佳实践
argument-hint: [file-or-range]
disable-model-invocation: true
allowed-tools: Read, Bash(git:*), Grep
---

# 代码审查

审查范围：$ARGUMENTS

**审查步骤**：

1. **查看更改**
   ```bash
   git diff $ARGUMENTS
   ```

2. **读取完整文件**
   使用 Read 工具查看被修改的文件

3. **检查项**
   - [ ] 代码可读性和命名
   - [ ] 错误处理
   - [ ] 安全漏洞（SQL 注入、XSS 等）
   - [ ] 性能问题
   - [ ] 测试覆盖
   - [ ] 文档完整性

4. **生成报告**
   ## 代码审查报告
   - ### 总体评估
   - ### 发现的问题（按优先级排序）
   - ### 改进建议
   - ### 最佳实践引用
```

### 示例 2：数据库迁移助手

```yaml
---
name: db-migrate
description: 创建数据库迁移文件并生成回滚脚本
argument-hint: [migration-name]
disable-model-invocation: true
allowed-tools: Read, Write, Bash
---

# 数据库迁移助手

创建迁移：**$ARGUMENTS**

**步骤**：

1. **检查迁移目录**
   ```bash
   ls -la migrations/
   ```

2. **创建迁移文件**
   文件名：`migrations/$(date +%Y%m%d%H%M%S)_$ARGUMENTS.sql`

3. **生成模板**
   ```sql
   -- Migration: $ARGUMENTS
   -- Created: $(date)
   -- Description: <描述>

   -- Up Migration
   BEGIN;

   -- TODO: 添加你的更改

   COMMIT;

   -- Down Migration
   BEGIN;

   -- TODO: 添加回滚逻辑

   COMMIT;
   ```

4. **更新迁移日志**
   在 `migrations/README.md` 中添加条目

5. **提示用户**
   显示迁移文件路径，提醒填写 Up 和 Down 逻辑
```

---

## 7. 常见问题

### Q1: 技能没有被自动调用？

**可能原因**：
1. 描述不够具体或缺少关键词
2. 技能描述超出上下文字符预算（默认 15,000 字符）
3. 技能设置了 `disable-model-invocation: true`

**解决方案**：
```bash
# 检查可用技能
What skills are available?

# 检查上下文预算
/context

# 手动调用测试
/skill-name arguments
```

### Q2: 技能被过度触发？

**解决方案**：
- 使描述更具体
- 添加 `disable-model-invocation: true` 仅允许手动调用
- 使用更精确的关键词

### Q3: 如何调试技能？

**方法**：
1. 使用 `disable-model-invocation: true` 手动调用测试
2. 在技能中添加调试输出
3. 创建测试版本技能进行实验

### Q4: allowed-tools 不生效？

**检查**：
1. 使用逗号分隔格式：`allowed-tools: Read, Write`
2. 确保工具名称正确（区分大小写）
3. 检查权限设置是否覆盖技能配置

### Q5: 如何共享技能？

**方式**：

| 共享范围 | 方法 |
|----------|------|
| 个人使用 | `~/.claude/skills/` |
| 项目共享 | 提交到 `.claude/skills/` 并推送到 git |
| 团队共享 | 通过企业级 managed settings 部署 |
| 公开发布 | 打包为 [Plugin](https://code.claude.com/docs/en/plugins) |

---

## 附录

### A. 完整 Frontmatter 参考

```yaml
---
# 基本信息
name: my-skill
description: 技能描述
version: 1.0.0
argument-hint: [arg1] [arg2]

# 调用控制
disable-model-invocation: false  # true = 仅手动
user-invocable: true             # false = 隐藏菜单

# 工具和环境
allowed-tools: Read, Write, Edit, Bash
model: claude-sonnet-4
context: fork                    # 在子代理中运行
agent: Explore                  # 子代理类型

# 生命周期钩子
hooks:
  beforeInvoke:
    - run: echo "Starting..."
  afterInvoke:
    - run: echo "Done..."
---
```

### B. 代理类型对比

| 代理 | 适用场景 | 工具集 |
|------|----------|--------|
| `Explore` | 代码库研究、文件搜索 | Read, Grep, Glob（只读） |
| `Plan` | 架构设计、技术规划 | 规划专用工具 |
| `general-purpose` | 通用任务 | 完整工具集 |
| 自定义 | 特定领域需求 | 自定义配置 |

### C. 工具名称参考

**常用工具**：
- `Read` - 读取文件
- `Write` - 写入文件
- `Edit` - 编辑文件
- `Bash` - 执行 shell 命令
- `Grep` - 搜索文件内容
- `Glob` - 搜索文件路径
- `Task` - 启动子代理

**MCP 工具**（如 Playwright）：
- `mcp__playwright__browser_navigate`
- `mcp__playwright__browser_click`
- `mcp__playwright__browser_snapshot`

### D. 参考资源

- **[Claude Code Skills 官方文档](https://code.claude.com/docs/en/skills)**
- **[Agent Skills 开放标准](https://agentskills.io)**
- **[子代理文档](https://code.claude.com/docs/en/sub-agents)**
- **[插件开发指南](https://code.claude.com/docs/en/plugins)**
- **[权限管理](https://code.claude.com/docs/en/iam)**
- **[钩子系统](https://code.claude.com/docs/en/hooks)**

---

## 版本历史

- **v1.0.0** (2025-01-27): 初始版本，基于 Claude Code 官方文档整理

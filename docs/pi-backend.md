# Pi 后端（agentBackend）指南

`agents.<name>.backend: pi` 使用可选的 earendil-works/pi Agent 运行时。
通过 `llm` 绑定模型与 API 连接；支持 Anthropic Messages 和 OpenAI chat
completions 两种格式。配置失败会报错。

## 安装与配置

pi 运行包需要 **Node.js >= 22.19.0**。对通过 npm 安装的预构建分发包，
在安装目录执行：

```sh
npm install --no-save --package-lock=false @earendil-works/pi-agent-core@0.83.0 @earendil-works/pi-ai@0.83.0
```

源码 worktree 使用 pnpm；将所需运行包声明为 core 的可选依赖，并一并提交
manifest 和唯一的 pnpm lockfile：

```sh
pnpm --filter @disclaude/core add --save-optional --save-exact @earendil-works/pi-agent-core@0.83.0 @earendil-works/pi-ai@0.83.0
```

这些包是可选运行依赖；其他后端不依赖它们。不要在源码 worktree 中运行
`npm install` 或生成第二套 lockfile。
本次生产适配以 0.83.0 为验证版本，升级 pi 时须重新验证。

```yaml
agents:
  assistant:
    backend: pi
    llm: assistant
llms:
  assistant:
    model: your-model-id
    api:
      protocol: openai
      apiKey: $ASSISTANT_API_KEY
      # baseUrl: https://your-api.example/v1
```

`protocol: anthropic` 使用 Anthropic Messages。省略地址时使用该协议的官方
地址。凭据由服务环境提供；每个 query 独立解析连接，不修改全局环境。
可选包探测和配置校验不代表线上模型验收。

## 工具、会话与限制

- 原生 Bash、Read、Write、Edit 工具使用 query 的 cwd 和环境；工具名称保持
  disclaude 的现有命名。保留 Pi 的默认工具集。
- 业务工具通过 `tools: ToolDefinition[]` 注册；stdio/HTTP MCP 不在 pi 的支持范围内。
- 每个 query 独立创建 Agent；同一输入流支持多轮，取消会中止该查询。
  不承诺跨进程恢复原生会话。
- Claude 黑白名单不转译到 Pi；旧名单查询字段明确报错。
  NodeExecutionEnv 是执行环境，**不是文件系统沙箱**。
- 原生文本片段合并为完整消息再投递；thinking 不作为回复发送。
  上游 error 不会被伪装成成功 result。
- 自定义模型描述使用保守的客户端预算：32,768 上下文、4,096 输出 token。
  这不是对模型实际容量的声明；零计价字段也不是免费声明，当前不提供可信费用统计。
- Claude 的设置文件、插件和权限交互不自动迁移到 pi；本页不声称实现了
  Claude Code 的全部功能。

OpenAI 适配接口来源：[Pi 0.83.0 OpenAI completions adapter](https://github.com/earendil-works/pi/blob/v0.83.0/packages/ai/src/api/openai-completions.ts)。

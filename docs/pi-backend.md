# Pi 后端（agentBackend）指南

`agent.agentBackend: pi` 使用可选的 earendil-works/pi Agent 运行时，模型服务仍按
Anthropic Messages 协议配置。默认后端仍是 `claude`；选择 pi 后不会因配置失败
而静默回退到 Claude。

## 安装与配置

pi 运行包需要 **Node.js >= 22.19.0**。在安装 disclaude 的主机/工作区执行：

```sh
npm install --no-save --package-lock=false @earendil-works/pi-agent-core@0.83.0 @earendil-works/pi-ai@0.83.0
```

这些包是可选运行依赖，`npm ci` 后需要重新安装；其他后端不依赖它们。
本次生产适配以 0.83.0 为验证版本，升级 pi 时须重新验证。

```yaml
agent:
  agentBackend: pi
  provider: anthropic
  model: your-model-id
```

通过项目既有的私有配置或环境提供 `ANTHROPIC_API_KEY` 和
`ANTHROPIC_BASE_URL`。省略地址时使用 Anthropic 官方地址；DeepSeek 可使用其
Anthropic 兼容地址（以 `/anthropic` 结尾）。请勿将真实 key 写入仓库。
运行时从每个 query 的 model/env 解析模型和认证，不修改全局环境，也不需要
手工给 provider 注入 `streamFn`。显式缺失模型/key 或非 HTTP(S) 地址会报错。
`validateConfig()` 仅探测可选包，不代表凭证已通过线上验证。

## 工具、会话与限制

- 原生 Bash、Read、Write、Edit 工具使用 query 的 cwd 和环境；工具名称保持
  disclaude 的现有命名。声明式工具选择控制这些原生工具的枚举。
- inline 工具沿用现有适配器；stdio/HTTP MCP 不在 pi 的支持范围内（#4417）。
- 每个 query 独立创建 Agent；同一输入流支持多轮，取消会中止该查询。
  不承诺跨进程恢复原生会话。
- 工具调用仍经过已有的 `beforeToolCall` / `disallowedTools` 名称拒绝门。
  不新增权限系统；NodeExecutionEnv 是执行环境，**不是文件系统沙箱**。
- 原生文本片段合并为完整消息再投递；thinking 不作为回复发送。
  上游 error 不会被伪装成成功 result。
- 自定义模型描述使用保守的客户端预算：32,768 上下文、4,096 输出 token。
  这不是对模型实际容量的声明；零计价字段也不是免费声明，当前不提供可信费用统计。
- Claude 的设置文件、插件和权限交互不自动迁移到 pi；本页不声称实现了
  Claude Code 的全部功能。

## 真实验收

2026-09-10 使用用户指定的 `deepseek-v4.1-flash-expires-on-0910`，通过
Anthropic Messages 协议跑通 pi Agent 的回复、原生文件工具与读回、多轮随机
标记记忆、工具调用时取消、取消后新 query。最终候选 SHA 和完整测试结果以
[0.5.0 RC 记录](releases/0.5.0/release-candidate.md) 为准。

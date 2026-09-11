# DISCLAUDE_* 环境变量参考

单一事实源：变量名 / 读取点 / 默认值 / 状态。第三方变量（`ANTHROPIC_*`、`LARK_*`、`FEISHU_*` 等）见各模块文档，不在此表。

> 本表对应 Issue #4801（P6）。修改任一变量时请同步更新本文件 —— 否则变量名拼错、僵尸变量之类的问题会长期存活（见 #4801 的 P1/P2）。

| 变量 | 读取点 | 默认值 | 状态 |
| --- | --- | --- | --- |
| `DISCLAUDE_WORKSPACE_DIR` | `packages/core/src/config/index.ts` 工作区目录解析 | 配置 `workspace.dir` | active |
| `DISCLAUDE_CONFIG_PATH` | `packages/core/src/config/loader.ts`、`service/src/cli.ts`、`channel-cli/src/cli.ts` 配置路径解析 | 未设置时自动读取 `~/.disclaude/disclaude.config.yaml`；当前目录仅作迁移回退 | active |
| `DISCLAUDE_ALLOW_BUILTIN_CRON` | `service/src/agents/disallowed-tools.ts`（经 `buildDisallowedTools(env)` 的 `env` 参数读取，非 `process.env.` 字面量） | 未设置 = 禁用内置 cron 工具 | active（truthy `1` / `true` 时放开） |
| `DISCLAUDE_API_BASE_URL` | `channel-cli/src/cli.ts`、`channel-cli/src/tools/channel-api-utils.ts` REST 客户端 | `http://localhost:19200`（目前两处各自硬编码字面量；#4804 会收敛为单一常量 `REST_IPC_DEFAULT_BASE_URL`） | active |
| `DISCLAUDE_API_TOKEN` | **暂无生产读取点** —— `getChannelApiClient()` 构造 `ChannelApiClient` 时不传 token；仅 `docs/designs/rest-channel-api-design.md` 描述了目标形态 | 无 | **planned（待 #4804）** —— 现在设置了不生效，主服务开 `--api-token` 时 channel 写请求仍会 401 |
| `DISCLAUDE_REST_IPC_ENABLED` | 无（已废弃） | — | **deprecated / 已废弃**，REST 是唯一通路，设置了也无效 |
| `DISCLAUDE_STALL_TIMEOUT_MS` / `DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS` | `core/src/sdk/providers/{claude,codex}/provider.ts` 停顿检测 | 180000 ms / 运行时常量 | active |
| `DISCLAUDE_SYSTEM_FLOOD_THRESHOLD` | `core/src/sdk/providers/claude/provider.ts` 消息洪泛保护 | 50 | active |
| `DISCLAUDE_QUERY_MAX_RETRIES` | `core/src/sdk/providers/claude/provider.ts` 查询重试 | 运行时常量 | active |
| `DISCLAUDE_LAUNCHD_API_PORT` / `DISCLAUDE_LAUNCHD_API_TOKEN` | `scripts/launchd.mjs` 部署脚本 | 脚本内 | active（脚本注入） |
| `DISCLAUDE_GROUP_E2E` | 无生产读取点，仅 `docs/group-management-e2e.md` 提及 | 关闭 | 仅设计稿（`tests/e2e/group-management/` 未落地，见 `docs/group-management-e2e.md`） |
| `DISCLAUDE_WORKER_IPC_SOCKET` | 无 —— #4280 part 5 已从 `DisclaudeService.start()` 移除；唯一残留是 `service.rest-only.test.ts` 断言它**不被设置** | — | **removed (#4280)**，REST 是唯一通路 |
| `DISCLAUDE_MODE` | — | — | **removed (2026-09)**，历史残留，无读取点，已从 Dockerfile/compose 删除 |

## 维护提示

枚举本表时**不要只 grep `process.env.DISCLAUDE_`** —— `DISCLAUDE_ALLOW_BUILTIN_CRON` 经 `buildDisallowedTools(env: NodeJS.ProcessEnv = process.env)` 的参数对象间接读取，字面 grep 看不到。用宽 pattern 拿全集再逐个判定：

```bash
git grep -ho "DISCLAUDE_[A-Z_0-9]\+" origin/main | sort -u
```

宽 pattern 会额外命中两个**非环境变量**的同名标识符，不应收入本表：

- `DISCLAUDE_DIR_NAME` —— `core/src/channels/channel-directory.ts` 里的局部常量（值为 `.disclaude`）
- `DISCLAUDE_TEST_PROTECT_KEY__` —— `apply-global-env.test.ts` 里构造的测试字符串

另有 `DISCLAUDE_CONFIG`（无 `_PATH` 后缀）仅被 `tests/integration/rest-channel-test.sh` 读取，属集成测试脚本入参，不是运行时变量。

### Channel API configuration migration

Use `DISCLAUDE_API_BASE_URL` and `DISCLAUDE_API_TOKEN` for the DisclaudeService HTTP API. The former `DISCLAUDE_REST_IPC_BASE_URL` and `DISCLAUDE_REST_IPC_API_TOKEN` names are removed and are not read as fallbacks. Update external callers and regenerate launchd configuration when upgrading. Managed children receive the current HTTP address after the server starts.

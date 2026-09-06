# DISCLAUDE_* 环境变量参考

单一事实源：变量名 / 读取点 / 默认值 / 状态。第三方变量（`ANTHROPIC_*`、`LARK_*`、`FEISHU_*` 等）见各模块文档，不在此表。

> 本表对应 Issue #4801（P6）。修改任一变量时请同步更新本文件 —— 否则变量名拼错、僵尸变量之类的问题会长期存活（见 #4801 的 P1/P2）。

| 变量 | 读取点 | 默认值 | 状态 |
| --- | --- | --- | --- |
| `DISCLAUDE_WORKSPACE_DIR` | 工作区目录解析 | 配置 `workspace.dir` | active |
| `DISCLAUDE_CONFIG_PATH` | `channel-cli` 配置路径解析 | `disclaude.config.yaml` | active |
| `DISCLAUDE_REST_IPC_BASE_URL` | `channel-cli` / `push-cli` REST 客户端 | `http://localhost:19200`（单一常量 `REST_IPC_DEFAULT_BASE_URL`） | active |
| `DISCLAUDE_REST_IPC_API_TOKEN` | `channel-cli` / `push-cli` REST 客户端，透传 `RestIpcClient` | 无 | active（主服务开 `--api-token` 时必须一致） |
| `DISCLAUDE_REST_IPC_ENABLED` | 无（已废弃） | — | **deprecated / 已废弃**，REST 是唯一通路，设置了也无效 |
| `DISCLAUDE_STALL_TIMEOUT_MS` / `DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS` | 服务停顿检测 | 运行时常量 | active |
| `DISCLAUDE_SYSTEM_FLOOD_THRESHOLD` | 消息洪泛保护 | 运行时常量 | active |
| `DISCLAUDE_QUERY_MAX_RETRIES` | 查询重试 | 运行时常量 | active |
| `DISCLAUDE_WORKER_IPC_SOCKET` | 进程间通信 | 运行时生成 | 内部使用 |
| `DISCLAUDE_LAUNCHD_API_PORT` / `DISCLAUDE_LAUNCHD_API_TOKEN` | launchd 部署脚本 | 脚本内 | active（脚本注入） |
| `DISCLAUDE_GROUP_E2E` | 群聊管理 E2E 门禁 | 关闭 | 仅设计稿（`tests/e2e/group-management/` 未落地，见 `docs/group-management-e2e.md`） |
| `DISCLAUDE_MODE` | — | — | **removed (2026-09)**，历史残留，无读取点，已从 Dockerfile/compose 删除 |
# 0.6.3 Datalayer MVP：配置实例实测

2026-10-05，按用户要求将 0.6.3 候选增加 `datalayer` 后端，并在用户已有的远程 Jupyter 上实测。共享编辑、远程执行、模型续行及导出已经跑通；当前部署还不能满足 [Notebook 产品要求](./jupyter-harness.md) 的全部行为。这是可评审的 MVP 和组件证据，尚未发布，也未完成飞书产品验收。

## 实现与部署

宿主仍只运行 Node。复用 Jupyter 的密码登录、Contents、Sessions、kernel channels、RTC/YNotebook、nbmodel 执行队列和 nbconvert；不安装宿主 Python，不启动本地 Jupyter，也不要求远端安装 `disclaude_jupyter`。

`JupyterConnections` 的连接增加 `backend: "datalayer"`。凭据和私有 cookie jar 位于宿主；Project 仍只保存 `.jupyter/config.json` 的远端引用。每个会话的原始执行记录保存到 `.jupyter/datalayer-runs-<conversation-hash>.json`。标准 `ToolDefinition[]` 接入现有 DSH，ChatAgent 通过同一个 Notebook session 接口调用。

```json
{
  "version": 1,
  "connections": [
    {
      "id": "research",
      "backend": "datalayer",
      "baseUrl": "https://jupyter.example/",
      "passwordEnv": "JUPYTERLAB_PASS"
    }
  ]
}
```

配置文件需为宿主私有普通文件（0600），通过 `JUPYTER_CONNECTIONS_FILE` 指定。Project 引用的 `connectionId` 使用上述 ID。可用 `authorizationEnv`/私有文件替代密码；HTTP 的显式授权及凭据隔离规则沿用 [Service 文档](../jupyter-service.md)。一个 Project 的 Notebook 不能混用两个后端。省略 `backend` 保持原 coordinator 路线；其控制权、原子检查和持久 fence 的保证不适用于本 MVP。

工具为 `notebook_list`、`notebook_describe`、`notebook_read_cell`、`notebook_insert_cell`、`notebook_edit_cell`、`notebook_execute`、`notebook_status`、`notebook_stop`、`notebook_export`。编辑使用稳定 cell ID 和客户端源码哈希检查；执行前落盘原目标和 runId，未知提交不自动重放。服务端 GET 消费的终态在宿主缓存，导出用同一次捕获的共享文档生成 `.ipynb` 和远端 nbconvert HTML。

## 当前实例与实际协议

| 组件                                 | 实际版本                  |
| ------------------------------------ | ------------------------- |
| Jupyter Server / Lab                 | 2.19.0 / 4.4.1            |
| collaboration / server_ydoc / pycrdt | 4.4.1 / 2.4.1 / 0.13.1    |
| jupyter-server-nbmodel               | 0.1.1a4                   |
| jupyter-mcp-server                   | 1.0.2，来自已安装包元数据 |
| 本次真实模型 DSH                     | 0.1.2rc1                  |

MCP 的 health/initialize 返回硬编码的 `0.20.0`，不能用它判断安装版本。真实调用应使用 `/mcp` JSON-RPC；`/mcp/tools/call` REST 路径只返回占位成功。当前 `tasks/list` 返回 Method not found，不能套用新版 upstream Tasks 文档当作该实例的能力。

MCP 的共享写入和执行可用，但 `read_cell` 在实测中读到了落盘的 `mvp_value = 2`，独立 RTC 客户端已看到未落盘的 `mvp_value = 17`。MVP 因而直接使用原生 RTC 读取，而不将 MCP 的磁盘读取作为最新状态。

nbmodel 的提交返回 HTTP 202、空 JSON 和原请求 `Location`。0.1.1a4 的结果 `outputs` 为 JSON 字符串，Python 错误也返回 HTTP 200；客户端按实际结构解析终态。没有收到可验证原 handle 的提交保留为 unknown，不自动重发。

## 要求覆盖与未通过项

| 产品行为                             | 结果               | 实际证据及限制                                                                                                                                                                                      |
| ------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 持久 Project 引用，模型会话续行      | 通过组件测试       | 原 Project、Notebook 和 kernel 续行；跨后端/Project 引用检查。改名、复制的完整 UI 流程未验收。                                                                                                      |
| 读取未落盘的人类编辑                 | 通过               | 独立 RTC peer 改参数和 Markdown；宿主读取 live 状态，Contents 同时仍为旧参数。                                                                                                                      |
| 定点写入、保留其他 cell 和人工文字   | 通过所测场景       | 两轮真实模型保留人工正文；过期源码哈希返回 conflict。并发同 cell 的服务端原子 CAS 未实现，metadata/附件完整并发覆盖未验收。                                                                         |
| 同一远端 Python kernel 持续计算      | 通过               | 参数 17 得到 51；真实模型参数 23 得到 69，人工改成 31 后续行得到 93，kernel ID 相同。                                                                                                               |
| 人工/Agent 串行入口及控制权交接      | 部分 / 未通过保证  | 执行复用 nbmodel 队列；未实现服务端 owner generation、独占 kernel 或旧提交/输出/stop 失效。未把“kernel ID 相同”当作 incarnation 存活证明。                                                          |
| stdout、错误、PNG 图表及服务端输出   | 通过所测场景       | 实际远端 Matplotlib PNG 已保存并目视核验；解析真实 KeyboardInterrupt 输出。display 更新、clear、stdin、运行中改源码的全面覆盖未完成。                                                               |
| 所有文档客户端关闭仍执行并保存       | 执行通过，保存失败 | 67 秒执行在所有 RTC 客户端关闭后完成，原请求有 stdout，但 saved Notebook 对应 cell 的 outputs 为空；两次实验一致。浏览器关闭而宿主 RTC 仍连接与此条件不同。                                         |
| 精确停止原请求并核验结果             | 当前实例不支持     | 请求级 DELETE 返回 405。工具报告 unsupported/unknown，不退化为整个 kernel interrupt。只在自有 scratch kernel 上单独测试标准 interrupt，原请求确实返回 KeyboardInterrupt；这不通过请求级 stop 要求。 |
| 原运行重复查询、Host 重建恢复        | 部分通过           | 重复 runId 没有第二个提交；宿主已缓存的终态可在新 Node 进程查询。远端终态 GET 会消费记录，第二次或其他消费者读取后为 404；宿主未缓存的结果不能恢复。                                                |
| 未知提交、远端重启与 kernel 丢失恢复 | 保守处理 / 未验证  | 本地记录先于 POST，未知不重放；没有永久服务端 run-ID fence、跨进程并发幂等或 incarnation 对账。未重启用户 Jupyter/kernel；服务端内存任务重启恢复没有验收证据。                                      |
| 同版本 Notebook / HTML / 图表交付    | 通过组件测试       | 同一次 live snapshot 写成 ipynb，由远端 nbconvert POST 转 HTML，附 snapshot SHA-256；PNG 已包含。实际设备可达、飞书附件/摘要、HTML sanitizer/CSP 与浏览器预览未验收。                               |
| 凭据隔离、Node-only 宿主             | 通过               | 宿主变量和 cookie 留在私有配置；检查工具/Project 和 DSH 原生历史无密码或 OAuth token。未启动宿主 Python/Jupyter。                                                                                   |
| 完整飞书研究体验与干净 kernel 复现   | 未验收             | 本次没有切换生产机器人，没有用户原生 Lab 编辑/Run/Interrupt 或研究报告完整产品验收。                                                                                                                |

输出预览已有大小上限，但完整大输出产物引用和明确截断提示尚不完整，不能以小样本 PNG 通过替代大输出要求。客户端源码哈希检查也不能替代服务端原子版本检查。MVP 的本地执行日志按单宿主 writer 使用，不提供分布式锁。

## 可复验材料

探针与命令见 [测试指南](../../tests/jupyter/README.md#configured-datalayer-mvp-probes)。它们只创建带随机名字的自有 Notebook/Project/session，清理自身 kernel/session，保留合成 Notebook、报告和宿主私有证据；不更新远端包、不修改配置、不重启用户服务。

本次本地证据（位于任务 worktree `.local/`，不提交包含连接状态的原始记录）：

- `datalayer-live-03/report.json`：完整组件探针，17 项中 12 项通过、5 项失败/不支持；`completed` 只表示探针执行结束。
- `datalayer-live-03/fresh-node-recovery.json`：另一个 Node 进程恢复原 51 的终态，无重新提交。
- `datalayer-live-03/nbconvert-export.json`、`nbconvert-report.html`、`chart.png`：最终官方 nbconvert 导出及实际 PNG 图表。
- `datalayer-model-03/report.json`、`report.html`：真实 DSH 两轮续行和最终 HTML 导出，17 次工具调用。实际两轮路由均为 `openai-codex` / `gpt-5.6-luna` / low，原生 session 恢复、人工参数/正文保留、凭据不进入历史均通过。
- 主仓库 `.local/063-jupyter/datalayer-mvp-notebook-test.json` 和 `datalayer-mvp-installed-source.json`：安装元数据、MCP 共享写入/执行、落盘读取滞后及任务接口调查。

原有 9 个 kernel 和 9 个 session 在探针清理后仍在，日常飞书服务及模型默认配置未动。`gpt-5.6-luna` 仅作为 #5215/#5219 指定验收覆盖；日常/候选默认仍为 `gpt-6-luna`。

前两轮探针暴露的 RTC 路径编码、旧版输出格式、DSH schema 子集和 HTML GET 的 XSRF 差异已经修正，失败证据保留。最终导出走官方 POST `/nbconvert/html`，不依赖手写 Notebook HTML 渲染。

## 后续接入判断

这些实测不足以说明 Datalayer 本身永远无法满足要求，也不足以支持继续重写整个执行层。优先保留本 MVP 的 RTC、nbmodel、nbconvert 和薄宿主适配。先针对当前失败补齐或验证文档生命周期/输出保存、持久且可重复读取的原请求结果、准确的请求级取消，再决定是否需要小范围 upstream 扩展。

历史独立栈实验曾用 `YDocExtension.document_cleanup_delay = None` 通过保留文档的后台保存场景，详见 [原证据](./jupyter-harness-evidence.md) 和 [实验指南](../../tests/jupyter/README.md#server-retention-comparison)。它不是当前远端已经通过的证据；未更改用户配置，也不能据此宣称服务端重启恢复成立。任何版本升级或保留设置仍需在用户实例上重新验收并评估现有 Notebook 影响。

严格 owner generation、服务端原子源码检查和永久迟到提交 fence 若继续作为发行条件，需要有具体实现及并发/故障证据；本 MVP 没有伪造这些保证。完整飞书、原生 UI、用户设备访问和远端重启仍是独立未完成验收。

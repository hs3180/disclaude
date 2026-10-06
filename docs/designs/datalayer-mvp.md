# 0.6.3 Datalayer MVP：配置实例实测

2026-10-05 增加 `datalayer` 后端，并在用户已有的远程 Jupyter 上实测。2026-10-06 的修复候选已通过原六个失败场景的第一轮远端复验。完整 [Notebook 产品要求](./jupyter-harness.md)、飞书、原生 Lab 和设备验收仍未完成；以下按源码和实例区分当前修复证据与历史失败。

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

配置文件需为宿主私有普通文件（0600），通过 `JUPYTER_CONNECTIONS_FILE` 指定。Project 引用的 `connectionId` 使用上述 ID。可用 `authorizationEnv`/私有文件替代密码；HTTP 的显式授权及凭据隔离规则沿用 [Service 文档](../jupyter-service.md)。一个 Project 的 Notebook 不能混用两个后端。当前适配层省略 `backend` 时默认选择 Datalayer；旧 coordinator 需显式指定，其控制权、原子检查和持久 fence 的保证不适用于本 MVP。历史实验记录仍以当时的源码和显式后端配置为准。

工具为 `notebook_list`、`notebook_describe`、`notebook_read_cell`、`notebook_insert_cell`、`notebook_edit_cell`、`notebook_move_cell`、`notebook_delete_cell`、`notebook_execute`、`notebook_status`、`notebook_stop`、`notebook_export`。编辑使用稳定 cell ID 和客户端源码哈希检查；执行前落盘原目标和 runId，未知提交不自动重放。原结果按远端明确保留策略查询并在宿主缓存，导出用同一次捕获的共享文档生成 `.ipynb` 和远端 nbconvert HTML。

后续宿主改动已增加执行政策检查、原生 kernel incarnation、服务实例与 Location
记录、显式关闭 stdin、独占 kernel 检查及大输出／历史结果提示。未声明安全目标取消政策
的服务不会收到取消 DELETE，也不会创建新的执行 kernel；原生 incarnation 改变后拒绝
把下一次运行称为原内存续行。29 项相关组件检查、build 和 lint 通过；这些宿主改动在
配置远端的复验仍未完成。

第二轮开发已补充稳定 cell 的移动/删除、原生文件 ID 反查改名路径、Project 解除关联
后的异步写入拒绝，以及不打开 RTC 文档的原请求查询。缓存终态可在离线的新宿主读取；
预览明确标记截断并保留认证的原结果/完整产物入口。取消后最多等待 15 秒确认原请求
终态，204 不算停止；导出保留捕获快照并报告期间 live 版本变化。原生移动会重建 CRDT
源码对象，服务端监听相应重新绑定，结束时释放监听。当前宿主 75 项测试、构建和
targeted lint、远端隔离测试进程 34 项回归通过；新增配置远端集成探针尚待执行。

## 修复候选第一轮复验（2026-10-06 UTC）

远端候选源码为 `79c2bf82f`，镜像为
`sha256:0f7a907190d9c0afa4a5c05a8952fbe154a06baa8de9ed38414c9d007f3586ab`。
[固定补丁与部署说明](../../jupyter/datalayer/README.md) 的 manifest SHA-256 为
`99c4aa1770a03d738568f0a7ba8a273df1116c7d4cdd4947cd9dfbc187994061`。
本轮 Node 工具来源是 `16ad2ed23`；后续宿主 incarnation/能力检查改动需重新验收。
原镜像、运行配置和环境已保存回退副本，169 项发行包版本及 12 项科学计算依赖未变，
`pip check` 通过。空闲实例切换到 healthy 耗时 21.65 秒；登录入口观测不可用为
4.562 秒。原挂载与认证环境保留，日常飞书容器未切换。

实际启动验证了一小时非消费结果保留、512 条全局请求配额及 64 KiB inline 上限。
共享配置中 cleanup delay 为 `None`，由原生 ydoc 保存；没有宿主补写或常驻 RTC peer。
第一次启动预检使用错误格式的 kernel ID，第二次发现扩展发现 `.d` 文件未加载任意
trait 配置；修正探针并合并标准共享配置后复验通过，失败记录保留。

| 原失败条件                          | 本轮结果                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------- |
| 全部文档客户端退出后的保存          | 67 秒运行完成，原请求 stdout 和磁盘 Notebook 输出均包含完成标记。                  |
| 原结果重复读取／其他消费者先读      | 原请求重复 GET 和宿主未缓存时另一个消费者先 GET 后的恢复均通过，无额外执行 POST。  |
| 取消 queued B                       | running A 保持运行；B 有未执行的取消终态。                                         |
| 取消 finished unread A              | 新 running B 保持运行；读取仍得到原 A 终态。                                       |
| 执行中改源码                        | 原请求保留原输出；当前新源码 cell 无旧输出，未知 metadata/attachment 保留。        |
| display_id／clear_output(wait=True) | 内核实际发出更新；live MIME 使用更新值；wait=True 保留旧输出，下一输出到达时清空。 |

核心探针 18 项中 17 项通过，唯一不支持项是范围外 MCP Tasks；边界探针 19 项全部通过。
独立 Node 进程恢复 pending 原请求且没有执行 POST、改名/复制身份及自有 kernel 重启后的
原生 incarnation 变化也通过。补丁安装后 31 项服务端回归和实际 bundled modules 的
16 项前端检查通过。原始证据位于主仓库私有目录
`.local/063-jupyter/datalayer-delivery-20261006/`，包含 `configured-core-01/`、
`configured-edge-01/`、镜像构建、配置和中断记录。

这一轮没有完成原生 Lab Run 路由、多位置跨 cell display 更新、独立进程读取未缓存的
终态、大输出产物、故障恢复、真实飞书或设备验收。不能据此关闭完整产品／发行任务。
冻结最终交付源码上的复验仍需执行。原生 UI 会话在选择 Chromium 时被 Computer Use
工具因当前 URL 不允许访问而终止，没有继续或换工具绕过；这项保持未验证。
本轮结束前已恢复修复前的运行快照；Jupyter/MCP 和日常飞书服务健康，原挂载与认证
环境保留，未遗留自有 kernel/session。修复候选镜像和回退文件保留供下一轮验收。

## 更新后实例复验（历史：2026-10-05 UTC，上海时间跨至 10-06）

依赖更新并重启后，重新测试了用户配置中的同一远端 Jupyter。MCP 为 **2.2.3**，nbmodel 为 **0.2.9**，Lab / Server 为 **4.6.4 / 2.21.1**，collaboration / server_ydoc / pycrdt 为 **5.0.4 / 3.0.4 / 0.14.8**。本轮只创建自有随机 Notebook、Project 和 kernel；没有再次重启服务或修改其配置。此前的升级前结果保留在下文。

**结论：常规 MVP 流程通过，全部 Notebook 产品要求尚未满足。** 以下失败来自当前实例的实际请求与共享文档，不是对上游能力的推测。缺少 MCP Tasks 路由单独作为协议调查，不作为产品失败的理由。

| 当前行为                      | 复验结果与证据                                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live 编辑、持续计算和模型续行 | 通过。独立 RTC peer 的未保存参数、Markdown 可读取。真实 DSH 两轮均为 `openai-codex` / `gpt-5.6-luna` / low，在同一 Project、Notebook、kernel 和原生模型 session 得到 69，再由人工参数 31 得到 93；人工文字保留，HTML/ipynb 导出成功。                 |
| 宿主连接重建、原请求去重      | 所测场景通过。运行尚未结束时，销毁 Notebook session 和连接对象后，由独立 Node 进程查询同一 request ID 并得到 43，随后宿主重建恢复缓存；整个过程只有一次执行 POST，kernel incarnation 未变。已缓存终态也可恢复。此实验不是宿主机器重启或远端重启验收。 |
| 过期写入与其他内容            | 观察到 stale sourceHash 后拒绝编辑，人工新文字保留；源码定点编辑保留未知 metadata 和 Markdown attachment。通过这些场景不代表服务端原子 CAS 或并发控制权交接已经实现。                                                                                 |
| 文件身份与 kernel 进程身份    | 原生 API 改名后 document ID 相同，复制后不同；重启自有 kernel 后 kernel ID 相同、incarnation 改变。后端已提供身份信息，Project 自动跟随改名及 MVP 执行日志的 incarnation 对账仍待接入/验收。                                                          |
| 普通输出与导出                | stdout、stderr、结构化 ValueError、静态 PNG 及同快照 HTML/ipynb 通过；PNG 已目视核验。                                                                                                                                                                |
| 全客户端断开后的保存          | **失败。** 67 秒的后台执行完成，原请求有 stdout；落盘 Notebook 对应 cell 的 outputs 为空。                                                                                                                                                            |
| 远端原结果重复读取            | **失败。** 第一次 GET 消费终态，第二次 GET 为 404；另一个消费者先读取、宿主尚未缓存时，恢复为 unknown。宿主缓存仅解决已经读到的结果。                                                                                                                 |
| 精确取消                      | 取消当前 running 请求通过，原请求返回 KeyboardInterrupt。**取消目标校验失败：**取消排队 B 会中断正在运行的 A，B 随前一请求失败而被队列取消；取消已经完成但未读取的 A 会中断新运行的 B。DELETE 接受不等于目标正确。                                    |
| 执行中修改源码                | **失败。** 原请求可查询旧结果，但共享 cell 已是新源码，仍附旧执行的 stdout，metadata 只有 trusted 标记，没有旧源码版本/历史结果标识。                                                                                                                 |
| `display_id` 更新             | **失败。** 同一父消息、同一 display ID 的 `update_display_data` 已由 kernel 发出；nbmodel 原请求及共享 cell 仍保留更新前 MIME 内容。                                                                                                                  |
| `clear_output(wait=True)`     | 最终替换输出正确；**等待语义失败。** kernel 发出 wait=true 后、下一输出尚未到达时，原请求仍 202，但旧输出已被清空。不能用最终快照正确代替等待期间的行为。                                                                                             |

新版请求 DELETE 已解决旧版 405；核心探针将请求取消和整 kernel interrupt 分成两个执行，均单独核验原请求终态，避免连续中断同一请求的错误处理。取消其他请求的两种失败属于原生 nbmodel 目标校验问题，不能因正常 running 取消成功而略过。

源码核对也与输出实测一致：发布的 nbmodel 0.2.9 `_output_hook` 中 `update_display_data` 尚为占位，`clear_output` 立即清空且尚未处理 wait 参数。这两处需要针对性修复；普通 MIME 展示本身可复用。RTC 文档保留配置、结果存储、取消目标与输出版本关联也应优先在现有 Datalayer/Jupyter 集成中补齐，无需由这些失败推导出另建完整执行插件。

仍未验收：完整飞书持久 Project UX、原生 Lab 人工 Run/Interrupt、控制权交接与旧 owner 失效、服务端原子版本检查、持久迟到请求 fence、服务/机器重启恢复、完整大输出产物、stdin、设备访问及 HTML sanitizer/CSP、干净 kernel 的研究复现。这些与已经观察到的失败分开记录。

本轮证据在任务 worktree 的私有 `.local/`：

- `datalayer-reacceptance-core-01/report.json`：18 项，14 通过；4 项失败/不支持，其中 Tasks 仅为能力调查。
- `datalayer-reacceptance-edge-02/report.json`：11 项，8 通过；取消目标的两种误中断与源码改动后输出归属失败。
- `datalayer-reacceptance-capabilities-01/report.json`：改名/复制身份两项通过；输出更新的早期复验保留。
- `datalayer-reacceptance-output-03/report.json`：5 项，3 通过；保存 kernel IOPub 证据，动态更新和 clear wait 语义失败。
- `datalayer-reacceptance-fresh-node-01/report.json`：5 项均通过；独立 Node 进程在原请求 running 时恢复查询、零执行 POST，随后原宿主恢复缓存并保留 metadata/attachment。
- `datalayer-reacceptance-model-01/report.json`、`report.html`、`tool-errors.json`：真实两轮模型续行与导出通过。18 次工具尝试中 1 次因模型使用了错误 Notebook ID 被 Project 边界拒绝，之后使用正确 ID 完成；不将每次尝试都记录为成功。

核心与边界各轮均为 0 → 0 kernel/session，真实模型的自有 kernel/session 已清理；原资源保留，Jupyter 与日常飞书服务保持健康。密码和 OAuth token 未进入工具、Project 或模型原生历史。边界第一轮把上游 `output_type` 与宿主预览 `outputType` 混用，导致恢复断言误报，原始证据保留；修正后的第二轮恢复及去重通过。

## 升级前实例与实际协议（历史）

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

## 升级前要求覆盖与未通过项（历史）

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

## 升级前可复验材料（历史）

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

2026-10-06 按用户要求，发行目标已调整为 [Datalayer 研究闭环](./jupyter-harness.md)：后台保存、结果留存、目标取消、源码/输出关联和 display/clear 修复分别由 [#5262](https://github.com/hs3180/disclaude/issues/5262)–[#5266](https://github.com/hs3180/disclaude/issues/5266) 跟踪，仍是本版必过条件。多控制方 owner generation、服务端原子源码检查和永久迟到提交 fence 改由 [#5267](https://github.com/hs3180/disclaude/issues/5267) 按实际用例评估，不纳入 0.6.3 milestone。

该范围调整没有改变本轮实验结果或把失败记为通过。完整飞书、原生 UI、用户设备访问和远端重启仍是独立未完成验收。后续开发已增加默认 Datalayer 选择与安全连接诊断；引用兼容、Lab Run 入口和修复验收仍按当前任务逐项完成。

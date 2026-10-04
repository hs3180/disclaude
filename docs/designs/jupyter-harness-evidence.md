# Jupyter Harness 历史实验记录

以下保留截至 2026-10-03 的实验、失败和未验证条件，只证明各记录的提交与环境。现行设计见 [jupyter-harness.md](./jupyter-harness.md)。历史本地环境已经停止/移除；后续真实验收使用用户配置的远程 Jupyter。

### G0-A 证据与接入路线选择

2026-10-03 设计纠偏：此前根据 Codex scratch 成功与 DSH SDK/隔离环境缺口作出的“已选择 Codex”结论撤回。以下原始实验事实和限制保留；DSH 原生接入仍为主要路线，尚未通过的项继续标为未验证。

初始探针针对本机固定候选 `@deepseek-ai/dsh@0.1.2-rc.1` 的默认 SDK route：没有 Jupyter profile/plugin，选定的默认 provider 配置也没有 `openai-codex` route，因此在模型调用前以 `NO_ADAPTER` 结束。这个结果证明默认配置不能直接承载本需求，但不足以排除该版本 dsh 的其他原生 provider route。

2026-10-01 对同一安装做了隔离复核。标准 `sdk` profile 加载 `@deepseek-ai/dsh-llm-pi-ai`；随附 pi-ai `0.84.4` catalog 中有 `openai-codex` / `gpt-5.6-luna`，但当前用户 profile 没有启用这条 route。用仅含 provider/model 的临时 profile patch 注册该 route 后，SDK `initialize` 明确指定 `provider=openai-codex`、`model=gpt-5.6-luna`、`reasoningEffort=low`，服务端成功返回 `deepseek-harness-sdk-runtime`。这证明固定版本能解析该精确 route，不证明已认证、调用了真实模型或完成 Jupyter 工具调用。该隔离 DSH home 没有 OpenAI API key 或 `openai-codex` OAuth record，因此本轮没有发模型请求。`sdk` 与 `sdk-minimal` 的默认 profile dump 都没有 Jupyter/Notebook 插件。

2026-10-02 对本机安装的 `dsh@0.1.2-rc.1` 另用独立临时 `DSH_HOME` 枚举发行模板：随包 profile 为 `acp`、`headless`、`sdk`、`sdk-minimal`、`web`；逐个检查模板及默认 package patches，未发现 Jupyter/Notebook 集成引用。安装包的 `HarnessSdkRequestMap` 实际键也只有 `initialize`、`session/prompt`、`shutdown`，与上面的 SDK 控制面结论一致。这次核查覆盖发行配置，不覆盖用户自定义 profile 或产品接入。

取消与事件接口需按接入方式区分：SDK 提供 `session.event`（完整会话日志事件信封）和 `session.status`（running/idle）通知，但 `session/prompt` 只回传持久入队的 `messageId`，不标识最终助手回复、`turn/end` 或每个事件对应的提示词；尚未验证它与飞书消息/执行身份的关联。SDK 协议只有 `initialize`、`session/prompt` 和 `shutdown` 请求，没有远程 cancel/session-close 或 resume 方法；同一运行时可向原 session 继续排入提示词，重启后如何恢复不由该协议提供。关闭 runtime 会放弃整条 Agent runtime，不能据此宣称 Jupyter kernel 已停止。`dsh-agent` 的进程内 API 提供 create/resume/cancel/whenIdle，但尚未验证 Disclaude/飞书怎样调用该控制面，或如何把取消传递为 Jupyter kernel interrupt。这些是现有接入方式的缺口；G0-A 继续验证 DSH 原生插件与 Agent 控制面的最小适配，issue 保持未完成。

2026-10-03 对本机安装的 `dsh`、`dsh-tools`、`dsh-agent`（均为 `0.1.2-rc.1`）类型声明做只读复核：`dsh-tools` 的 registry 提供接收 `ToolDefinition` 的 `register`，工具执行上下文包含调用身份与 `AbortSignal`；`dsh-agent` 的 registry 声明提供 create/resume。该证据确认需要评估的原生扩展与控制入口确实存在，不证明已配置模型凭据、注册了产品 Notebook 插件或通过真实模型/飞书取消验收。

#### DSH 原生控制适配与真实模型组件验证（2026-10-03）

实现通过受管理的临时 profile patch 加载 `disclaude-dsh-native-app`，调用固定版本的 `dsh-tools.register` 和 `dsh-agent` create/resume/cancel/whenIdle。窄控制面增加宿主工具回调及明确的 session/open、session/cancel；这些方法属于 disclaude 插件协议。模型、provider route 和 reasoning effort 传给原生 Agent，未显式设置时采用所选 profile 的配置。原 profile 文件由 DSH 管理，临时 patch 在进程退出后清理。

共同 `HostToolDefinition` 使用 JSON Schema、结构化返回值与 `AbortSignal`；`createNotebookTools` 将它映射到共享文档和执行 ports。工具仅绑定宿主已授权的 Notebook，原生调用 ID 用于 trace，执行 runId 与控制者代次沿用 Jupyter 契约。当前 ports 尚无产品后端实现。业务定义统一由 `hostTools` 提供，DSH/Pi 使用原生 registry，Codex app-server 使用 dynamic tools，Claude 由适配器包装为进程内 MCP；详见 [Agent 工具契约](agent-tools.md)。这些适配器验证不扩大既有真实模型或 Notebook 产品验收的提交范围。

04:33 CST 在真实 `dsh@0.1.2-rc.1` / Node `v26.10.0` 下，显式使用原生 `openai-codex` route、`gpt-5.6-luna` / `low`，四阶段组件探针通过：一次原生工具调用保留 canonical 对象；新 provider/进程恢复同一 native Session 并复述前轮随机 marker；取消信号到达宿主 handler，确认在其清理完成后返回；中断后同一 Session 再次调用工具成功。原生日志回读的四条 request/header 均记录该 route、模型和 effort，扫描 114 条存储记录未发现本次 access credential。两个 provider 的清理完成，专用临时 DSH_HOME 删除。

本轮原生工具处理的是探针 marker，没有调用 Jupyter 文档或 kernel。取消结果仅确认 Agent 推理与本次宿主工作静止，远程执行停止仍为 `not_confirmed`。飞书 ChatAgent 接入、真实 Notebook read/edit/run、人工协作、kernel 可靠停止及产品恢复仍未验证。会话引用按 sessionKey/cwd 持久化，打开结果不明时只尝试原 native Session 的 resume；配置要求同一 DSH_HOME 由一个宿主服务写入，尚无跨宿主并发租约。

保留此前失败：进程退出前清理临时目录曾遇 ENOTEMPTY，适配器现等待实际退出；child cwd 曾错误继承仓库 `.env` 而触发 DSH 启动限制，现使用当前 Project cwd；首次原生日志扫描漏掉嵌套 zstd 文件，修正为未验证后采用探针专用明文日志补验；补验配置遗漏持久化 root、原生工具名误传 inherited restrict API、request/header 读取层级错误也分别记录为失败。上述修正不修改用户 Jupyter 配置，也不将初期 DSH 缺少隔离凭据的结果描述成产品不可接入。

Codex 可选适配的实验是在 app-server 中注册动态 host tool，由 disclaude host 通过认证的 Jupyter Server API 处理请求。Codex CLI `0.159.2` 的隔离协议探针在 `initialize.capabilities.experimentalApi=true` 下，以 `gpt-5.6-luna` 调用一次 `jupyter_get_notebook`；host 读取实际 Jupyter `contents` 响应中的文档 ID、cell ID 和 marker，模型在完成回复中复述了这些值。该探针没有通过飞书运行。

后续分支验证见 [PR #5226](https://github.com/hs3180/disclaude/pull/5226)：Codex provider 的 app-server 路径现可注册 namespaced dynamic function，并将 `item/tool/call` 路由给 inline host handler。一次显式指定 `gpt-5.6-luna`、`low` reasoning 的真实模型探针读取了用户提供的 Jupyter Server 2.19.0：host 通过 Contents API 创建唯一的临时 Notebook，模型调用 `read_notebook` 后收到正确路径、cell ID 和 marker 校验；host 核验身份后删除文件，Contents API 随后返回 404。没有打开、修改或执行任何既有 Notebook，也未创建 kernel。该结果验证一次 provider-to-host-to-Contents 读取链，不验证执行身份、取消、RTC、后台运行、Feishu 或完整产品验收。

2026-10-01 14:41 CST 补做了一次 provider-to-kernel scratch 探针：在 #5226 的 Codex app-server 动态 host-tool 分支，经 Codex provider 发出一次真实模型调用，显式指定 `gpt-5.6-luna` / `low`。本轮实际加载了 `~/.disclaude/disclaude.config.yaml`，provider 日志确认该回合使用上述模型和 effort。模型调用唯一的 `run_scratch_cell` 工具；一次性实验 host handler 校验随机 probe ID，在远程用户 Jupyter Server 创建的 UUID scratch Notebook 与 `conda-base-py` kernel 上，只执行固定 `print` 标记。该请求收到匹配的 `execute_reply: ok` 与 IOPub `idle`，host 经 Contents API 写入输出并立即读回，确认 cell ID、源码和输出 marker 一致；随后 session 与 Notebook 删除均返回 204，Contents 回读为 404。没有打开 Lab 页面或触碰既有 Notebook/kernel。该探针证明候选 provider 的动态 tool dispatch 可触发一次受限远端 Jupyter kernel 执行并由 host 持久化结果；handler 是一次性实验代码，不能代表产品 Jupyter 适配器。它不证明 RTC、人工未保存编辑、Agent 管理的页面关闭执行、控制权交接、取消/迟到结果、Feishu 或完整产品闭环。

PR #5226 已合并，Codex app-server 路径提供 opt-in 通用 host-tool 适配，尚不包含产品 Notebook 工具。提交 `a996b0ae` 将 app-server 的 request、tool call、thread 与 turn ID 传入 inline host handler 的调用身份；定向测试、core build/type-check 和 ESLint 在本地通过，该头 GitHub CI 6/6 成功。2026-10-01 的独立双轮真实模型探针在 Codex CLI `0.159.3`、`gpt-5.6-luna/low` 下，以同一 query stream 连续输入两轮；每轮由独立 app-server 进程承载，第二轮 `thread/resume` 未携带 `dynamicTools`，但同一个 marker host tool 仍在两轮各执行一次，保持同一 thread ID、使用不同 turn ID。探针使用隔离临时 cwd 与只读 sandbox，结束后进程数归零并清理目录。这验证 Codex provider 级 thread 续接与 host tool 路由，不代表 Feishu ChatAgent 的研究会话恢复或 Jupyter 作业恢复。仍须在产品路径验证请求隔离、超时/取消、Jupyter kernel interrupt、Feishu 续行和服务重启对账。不要直接将用户输入回调改成通用 MCP/工具注册入口。

Codex app-server 动态工具 API 当前标为 experimental，产品实现须固定兼容版本并明确降级行为。工具 handler 只访问已授权连接中的服务端 Notebook；不能通过本地路径或 Project `cwd` 定位，也不能把 Jupyter 管理凭据交给模型。

Jupyter 侧验证使用隔离 localhost 栈：Python `3.13.9`、JupyterLab `4.6.3`、Jupyter Server `2.21.1`、`jupyter-collaboration` `5.0.4`、`jupyter-server-nbmodel` `0.2.9`、ipykernel `7.4.0` 和 `httpx-ws` `0.9.0`。协议实验中，两名 RTC peer 同步了 Markdown 编辑；kernel 返回的 `42` 和输出写入并保存在 `.ipynb`；有效取消返回 204，过期取消返回 404 且未中断后续执行。服务重启后文件中的人工编辑和输出仍在，但原 kernel 消失，变量内存不可恢复。2026-10-02 的 API-only 探针另验证了 `jupyter_server_nbmodel` 的无浏览器执行写回：隔离服务启用 `jupyter_server_ydoc`、`jupyter_server_nbmodel` 与 `server_side_execution`，创建临时 Notebook/kernel 并连接独立 `pycrdt` Provider 后，`POST /api/kernels/{id}/execute` 返回 202，关联请求轮询到 complete；Contents API 随后读到 `execution_count=1` 和输出标记。全程没有打开浏览器页面，清理了临时 session、Notebook、server 和 root。以上证明该固定隔离组合的一条 server-side execution 路径能写回 Notebook；仍不证明真实用户服务兼容、产品 Agent/Feishu 集成、关闭并重新打开实际 Lab 页面、图表阅读或设备链接可用。

2026-10-02 在同一隔离栈做了无浏览器执行中断探针：长 cell 首先输出随机标记，随后对该 request URL 发 DELETE 得到 204；继续查询得到 HTTP 200、`request_status=complete`、execution `status=error` 和 `KeyboardInterrupt` 输出。写回的 `.ipynb` 包含开始输出与中断错误，没有迟到的打印标记；同一 kernel 随后成功运行另一个 cell。执行请求的 HTTP 200 和 `request_status=complete` 本身不代表成功，客户端还须读取 execution `status` 与错误输出。探针没有打开页面；kernel session、Notebook、隔离 server 和 root 均已清理。它验证 nbmodel `0.2.9` 的这一条中断路径，不验证 Disclaude `/stop`、控制者代次、并发所有权、Agent 断连重查或 server 重启对账。

2026-10-02 用同一隔离栈补做了实际 JupyterLab 前端 RTC 探针。独立临时 Server 使用 JupyterLab `4.6.3`、Jupyter Server `2.21.1`、`jupyter-collaboration` `5.0.4`，与长期运行的另一测试 Server、用户远程 Jupyter 和 Project workspace 分开；使用 Chromium `155.0.8057.0` 无头打开同一个 scratch Notebook 的两个页面。两页各自建立 collaboration room WebSocket。第一页通过编辑器将 cell 从 `# ORIGINAL_NOTE` 改成 `# HUMAN_EDIT_NOT_YET_SAVED`；第二页实时读到该修改，而紧接着读取 Contents API 仍只返回原文。YDoc 保存延迟设为 30 秒，以明确区分共享内存状态与已落盘 Notebook。随后一个独立 Python `pycrdt` `Provider`/`Channel` 客户端以同一服务认证连接该 room，通过 `YNotebook` 读取到了同一 cell ID 和未保存源码；peer 连接和源文本匹配均成功，读取前后 Contents API 仍返回原文。这验证真实 JupyterLab 前端修改会进入同一协作文档，并在 Contents 保存前对另一个前端及协议 peer 可见；协议 peer 不是 disclaude 产品 host adapter，也未验证用户远程服务，因此不能据此宣称产品 Agent 已接通 RTC。页面自动产生的 1 个 notebook session 与唯一 scratch 文件按路径清理，隔离 Server 停止后删除了整棵临时 root；随后核查没有 `disclaude-063-rtc-ui-*` 临时目录残留。原有长运行隔离 Server 未触碰。本轮 UI 操作预算为 4，实际仅打开两页、编辑一次并观察一次同步；pycrdt peer 连接与 Contents 检查走协议/API。

2026-10-01 的用户 Jupyter 服务补充了一次远程执行协议探针：服务报告 Jupyter Server `2.19.0`，Python kernelspec 为 `conda-base-py`；基线为 9 个 kernel/session。没有打开任何 JupyterLab 页面，也没有读取、修改或执行既有 Notebook。通过 Contents API 创建 UUID 临时 Notebook 和新 session/kernel，协商 `v1.kernel.websocket.jupyter.org` 后只执行一个 `print` 标记；同一请求收到 `execute_reply: ok`、匹配的 IOPub `idle` 与 stdout。随后由探针通过 Contents API 保存输出并回读，确认 cell ID、源码和输出一致。清理前核验了临时 cell 身份，session 和 Notebook 删除均返回 204，后续 Contents 查询返回 404；kernel/session 数量都恢复为 9。此结果证明该远程服务允许不打开 Notebook 页面时经协议执行一个新 scratch kernel，并由客户端保存、回读结果；它不证明产品 Agent 能协调执行，也不证明所有 Notebook 页面关闭时的集成后台任务、未保存 RTC 修改、服务端自动写回、控制权交接、图表渲染、导出或 Feishu 闭环。该探针没有调用模型。

同一服务后续的第二个独立 scratch 探针验证了 SVG MIME、真实 kernel interrupt 和恢复：cell 输出包含带随机标记的 `image/svg+xml`，经 Contents API 保存和回读后仍可见；另一 cell 先输出 `probe-running` 再 `sleep(20)`，只在确认执行已开始后调用该临时 kernel 的 `/interrupt`，HTTP 返回 204，关联的 shell reply 为 `error/KeyboardInterrupt`，并收到同请求的 IOPub `idle`。随后同一 kernel 成功执行 `print('probe-recovered')`，且服务端 Notebook 保存/回读了 SVG 与恢复输出。session 和 Notebook 最终均以 204 删除，Contents 查询为 404，原有 9 个 kernel/session 数量恢复。它验证的是 Jupyter API/WebSocket 的底层能力，不验证 Agent 的 `/stop`、所有权/并发隔离、多个图表输出位置、绘图渲染、RTC、Feishu 体验或发行集成；没有触碰既有 Notebook，也没有调用模型。

另一次独立 scratch 探针检查该用户服务上已注册的 `jupyter-server-nbmodel` REST 执行路由：`POST /api/kernels/{id}/execute` 接收请求（202），按响应 `Location` 轮询后返回含随机标记的 SVG MIME 输出；执行完成后，Contents API 回读的序列化 `.ipynb` 在 10 秒观察期内仍未显示该 cell 输出，探针没有手动 PUT 输出。它证明 REST 路由接受执行并在请求结果中返回 MIME，不证明输出已持久化到常规 `.ipynb`。当时没有打开 JupyterLab 页面或 RTC peer，Contents 回读也不能单独判断共享文档/YStore 中是否已有输出、浏览器是否完成 reconciliation。Datalayer 当前文档将 RTC 列为实时 UI 同步的可选推荐项，并记录了服务端写入、浏览器未能整合协作历史的恢复场景；因此这条路径还须单独核验文档持久化与页面恢复，不能把请求结果等同于 Notebook 保存。[nbmodel README](https://github.com/datalayer/jupyter-server-nbmodel)、[输出 reconciliation 说明](https://jupyter-server-nbmodel.datalayer.tech/output-reconciliation/)。

临时 kernel 的 Python 环境只读检查得到 jupyter-server-nbmodel 0.1.1a4、jupyter-collaboration 4.4.1、jupyter-ydoc 3.5.0 与 pycrdt 0.13.1；同一环境运行 jupyter server extension list 时，jupyter_server_nbmodel 与 jupyter_server_ydoc 显示 enabled。该 CLI 来自 kernelspec 环境，不能单独证明 Jupyter Server 主进程实际加载的扩展集合；REST 路由探针只证明 nbmodel handler 可达。部署包是预发行版，因此当前上游文档和 main 源码不能替代对该部署版本的验证。此外，认证后的 GET /lab/api/extensions 返回 200，7 条记录中 jupyter-collaboration-extension、datalayer-jupyter-server-nbmodel 和 datalayer-jupyter-mcp-tools 均显示 enabled。该清单只确认 Lab 扩展 API 报告这些扩展已启用，实时 RTC 握手、页面输出 reconciliation 与恢复由后续隔离页面探针分别核验。

随后用 `.env` 中的 JupyterLab 凭据对 `datalayer-jupyter-mcp-tools` 扩展做了一次 UUID scratch 验证。未登录的 `GET /jupyter-mcp-tools/tools` 返回 302 并转到 `/login`；通过密码表单登录后，kernelspec API 与同一 tools 路由均返回 200，路由列出 228 条已启用的 JupyterLab 命令。为一个新建 scratch Notebook 打开单独的 JupyterLab 页面后，观察到 `/jupyter-mcp-tools/echo` 工具 WebSocket 和 collaboration room WebSocket。对扩展的 `POST /jupyter-mcp-tools/execute` 调用 `notebook_append-execute`，只运行 `print` 随机标记；HTTP 返回 200/success，标记出现在页面 DOM，并且 Contents API 回读的 `.ipynb` 同时包含该 cell 源码与输出。临时 session 与 Notebook 分别以 204 删除，Contents 随后返回 404，kernel/session 数量恢复到 9。该结果验证的是已认证的扩展 HTTP-to-JupyterLab WebSocket 命令桥及页面打开时的输出持久化；它没有通过 MCP JSON-RPC 客户端调用，也没有验证按 Notebook/用户授权范围、页面关闭后的执行、Agent 控制权或 Feishu 集成。

2026-10-01 22:22 CST 对该扩展的工具目录做了一次只读检查：认证 `GET /jupyter-mcp-tools/tools` 返回 200，`count=228`、`total=407`。目录项是 JupyterLab command ID；`notebook_append-execute` 的参数只有必填 `source` 和可选 `type`，`notebook_get-selected-cell` 没有参数。此次未调用命令。结合名称及前述页面探针，这证明的是围绕当前 JupyterLab 前端上下文的命令桥，没有证明按连接、服务命名空间、Notebook 文档身份和 cell ID 寻址的服务端工具契约；不把它直接当作 Agent 的资源 API。

边界更正：首次打开 JupyterLab 默认路由时，持久 workspace 自动恢复了多个身份未确认的 Notebook/文件协作 room，测试浏览器因此短暂同步了这些文档的协作状态。没有对恢复文档手动读取、编辑、执行或保存；测试页面已关闭。关闭后发现 scratch 路径仍保留在默认 workspace 布局。以当前 ETag 做条件 PUT，仅删除了本次 scratch 对应的一个布局项、Notebook 页面状态和最近记录；其余顶层状态项保留，当前焦点退回 scratch 前一项。workspace 回读确认 scratch 路径已不存在；HTTP 只读核验显示 scratch Contents 为 404，kernel/session 数量仍为 9。探针前没有保存原始当前焦点，故不能声称精确恢复了原焦点。本轮不能称为“完全未访问既有文档”；今后的 UI 探针须从新的隔离 workspace 进入，避免恢复既有标签页。没有修改 Jupyter Server 配置或扩展。

另一次仅针对 UUID scratch Notebook 的隔离浏览器探针打开 JupyterLab 页面并观察到 collaboration room WebSocket。页面打开时，nbmodel execute 提交返回 HTTP 202，按 Location 轮询返回 HTTP 200、`status=ok` 和 SVG MIME；但随机 stdout 标记未出现在页面 DOM，Contents API 也没有对应输出。关闭测试页面后，同一 scratch kernel 仍存在；第二次提交返回 HTTP 202，轮询返回 HTTP 200、`status=ok` 和 stdout 标记，但 Contents 仍没有输出。探针没有手动 Contents PUT。重新打开尝试在 Notebook panel 出现前超时，恢复状态未知。session 与 Notebook 均以 204 删除，Contents 查询 404，kernel/session 数量恢复为 9；没有访问既有文档或 kernel。此结果证明关闭页面期间可由 REST 路由执行并取得响应，但没有证明输出自动持久化、经 RTC 显示或重开后恢复，不能视为产品输出交付通过。

当前 Datalayer [输出 reconciliation 文档](https://jupyter-server-nbmodel.datalayer.tech/output-reconciliation/)说明前端 `outputRecovery` 设置默认关闭，并可在服务端已保存输出但 Notebook 页面未显示时启用。对用户部署的 `0.1.1--alpha.4` 扩展做只读核验时，`GET /lab/api/settings/` 返回 91 个设置 schema ID，但没有 nbmodel 项；`GET /lab/api/settings/@datalayer/jupyter-server-nbmodel:notebook-cell-executor` 返回 404 `Schema not found`。未尝试写设置。上游当前文档不能证明该设置已包含在用户当前预发行版；这一服务仍未能验证输出恢复配置路径。

该探针中一次 `/interrupt` 返回 204，但轮询终态为 `ok` 且未带 `KeyboardInterrupt`；没有记录各次轮询状态及中断与执行完成的时间关系，所以扩展路由的取消语义仍属未验证。session 与 Notebook 删除均返回 204，Contents 后续查询为 404，9 个 kernel/session 计数恢复；没有触碰既有 Notebook，也没有调用模型。

2026-10-02 10:13 CST 的补充探针在同一远程用户服务上，经 kernel WebSocket 执行一个使用合成数据的 Matplotlib cell。`execute_reply=ok`，IOPub `display_data` 包含 44,413 字节的 `image/png`；测试 host 将输出显式写回唯一 scratch `.ipynb`，Contents API 立即读回 execution count 与 MIME output。用本地图像查看器确认标题、轴标签、图例、标记、颜色分组和刻度可读。临时 session 与 Notebook 删除返回 204，随后 kernel 与 Contents 查询均为 404。该探针验证服务端 kernel 可产出静态图并经显式 Contents PUT 持久化；没有打开 JupyterLab 页面，也没有验证自动输出 reconciliation、产品 Agent/Feishu 报告预览、HTML 导出或真实分析结果。

### 可重复运行的冷 room 持久化门禁

`tests/jupyter/g0-stack-probe.py` 提供独立的 G0-B 实验，依赖固定在同目录 `requirements.txt`。它只启动和清理自身的 localhost Server、Notebook、kernel、浏览器及配置；普通安装和 CI 不增加 Python 依赖。通过实际 Lab 编辑器修改 Markdown 和参数后，独立 RTC peer 必须在 Contents 保存前读到修改；点击原生 Run 必须走 nbmodel execute API，并携带对应文档与 cell 身份。

2026-10-02 的冷 room 实验在上述固定栈、Python `3.13.9`、Playwright `1.63.0` / Chromium `153.0.8010.12` 下失败：人工编辑实时同步、原生 Run 和人工输出自动保存均成功；随后关闭全部 Notebook 页面并断开实验 peer，以 30 秒保存延迟、标准 60 秒清理延迟等待 61 秒，且确认 Server 已记录该 room 删除。此时 nbmodel 接受后台执行（202），原请求查询得到 `request_status=complete`、`status=ok`、stdout 与 SVG，但继续观察 45 秒后 Contents 中该 cell 的输出数量仍为 0。探针没有补写 Contents，最终退出 1；临时 kernel 数量归零、Server 退出、root 删除。

这条证据限定了前述无浏览器成功实验的结论：有存活的共享文档时可以自动写回，不能据此推断最后一个 peer 退出且 room 被清理后仍会保存。默认清理配置下的发行接入需要核验文档重新加载、执行期间生命周期与输出保存的衔接；延长有限清理 TTL 或一直保留页面不能替代这项验收。该次失败未到达重开页面、图表渲染和 HTML 导出断言，这些条件在默认配置下继续保持未验证。`outputRecovery` 的可选对照开关只修改探针自身配置，尚未作为该失败的修复验证。#5216 继续开放，#5217/#5218 的产品实现须明确所支持的文档生命周期并通过对应门禁。

### 服务端共享文档生命周期对照

固定版本 `jupyter-server-ydoc 3.0.4` 的 `YDocExtension.document_cleanup_delay` 支持 `None`，此时最后一个客户端断开后共享文档保留到 Server 退出。`get_document` 默认 `create=False`；nbmodel 0.2.9 的 `_get_ycell` 按 room ID 和路径查询时没有请求创建缺失 room。这些实际安装源码说明了已初始化文档与已清理文档的区别，不能将 REST 执行成功当成自动持久化证明。

2026-10-02 通过同一隔离探针的 `--room-retention server` 验证上述受支持配置。所有 Notebook 页面及独立 RTC peer 都关闭，61.032 秒后共享文档仍由 Server 保留；背景执行原请求 `complete/ok`，stdout 与 SVG 自动写入 cell，整个流程仅创建时发生一次 Contents PUT。重开 Lab 后人工参数和 Markdown 保留，实际渲染的 SVG 与保存输出一致；HTML 导出内容匹配，导出前后 Notebook hash 不变，响应 CSP 为不含 `allow-same-origin` 的 sandbox。`outputRecovery=false`，没有保留前端或 RTC 工具连接。六项 UI 操作完成后仅回收自身 kernel/server/root，均确认退出。

另用 `--unattended-bootstrap` 在同一固定栈独立两次验证首次无人打开 Lab 的初始化：通过服务端 API 创建 Notebook/kernel，由短暂的独立 RTC peer 读到预期 cell ID 和源码后断开。`document_cleanup_delay=None` 下，分别断开 61.051 与 61.202 秒后首次执行返回 `complete/ok`、`execution_count=1`，stdout/SVG 自动保存到目标 cell；Contents PUT 仅创建时一次，初始 cell ID/源码保留，UI 操作数为 0。临时 kernel/server/root 均确认清理。这证明隔离栈可以由 RTC 客户端初始化共享文档再无客户端执行，尚未接入产品 Agent。

这为托管发行栈提供了经过实验的文档保留与初始化配置候选；默认 60 秒清理后的失败仍保留。仍未验证清理后的文档重载、Server 重启后的重新建 room、执行/控制代次对账或长期资源限额。托管适配须在执行前建立当前共享文档并限制保留资源；外部实例按自身配置单独验证，不能自动修改用户服务的清理策略。两种配置的报告明确区分 room 删除与服务端保留，不把其中一种结果代替另一种。

## 当前交付边界

本提案保留初期 DSH 默认 route 与 SDK 的失败，后续已有 DSH 真实模型组件探针和原生控制适配；实际 Jupyter 调用与飞书产品路径尚未接通。#5226 的 Codex scratch 实验继续作为可选 adapter 证据，不改变 DSH 主要路线。各类隔离 RTC、nbmodel、kernel、持久化和用户服务 scratch 证据仍分别受其原始边界限制。

隔离 RTC 与用户服务双工作区 scratch 探针均观察到第二页面可见未落盘编辑，但没有连接 disclaude 产品 host adapter。用户服务的双页面探针观察到前端还建立了 kernel channel WebSocket；通道帧未检查，不据此声称没有与其他运行中 kernel 交互。MCP Tools 页面探针此前曾因默认 workspace 恢复而短暂同步多个身份未确认文档，随后只清理了测试创建的 workspace 引用，不能声称完全未访问既有文档。飞书入口、人直接编辑后的 Agent 接续、产品端页面关闭/重开恢复、同版本报告及真实设备访问仍未通过；下一步实现共同 Jupyter ports 与协调边界，再验证 DSH Notebook/飞书闭环。

### Jupyter 凭据可达性补充（2026-10-01 14:09 CST）

使用 `.env` 中的 JupyterLab 凭据访问用户提供的服务：未登录时 `GET /api/status` 返回 403；通过 Jupyter 密码表单登录后，同一路径返回 200。此项只证明凭据可认证到该服务；没有创建或读取 Notebook、创建 kernel，且没有将凭据或会话 cookie 写入证据。

### Provider-to-kernel interrupt 联合探针（2026-10-02 00:38 CST）

在 #5226 app-server dynamic host-tool 分支尝试将真实 `gpt-5.6-luna/low` 调用、远程 scratch kernel interrupt 和 Contents 保存/回读串成一次探针。runner 退出时只保留了 app-server `closed` / `processCount=0` 日志，最终结果行没有保存，无法确认是否观察到 provider abort、kernel `KeyboardInterrupt`、IOPub idle 或保存回读成功。随后认证检查确认远端恢复为基线 9 个 sessions / 9 个 kernels，且没有 `disclaude-cancel-*` 临时 Notebook 或 session 残留。该尝试记为结果不确定，不作为取消或持久化证据；后续探针须在清理前将每一阶段结果可靠落盘或输出。

### Provider-to-kernel interrupt 和输出持久化（2026-10-02 01:09 CST）

在 #5226 候选 `978ffaf5` 上用 Codex CLI `0.159.3` 重做联合探针。实际加载的 `~/.disclaude/disclaude.config.yaml` 解析为 Codex backend；运行日志与 query 参数均确认本轮显式覆盖为 `gpt-5.6-luna` / `low`、app-server、read-only sandbox、`networkAccess=false`，未切换生产服务。先前一次重做因测试客户端协商 Jupyter v1 二进制子协议却发送 JSON 文本而超时；改用同一服务支持的 legacy JSON WebSocket 后，真实模型只调用了一次 inline Jupyter host tool。handler 通过 Contents API 创建含目标 cell 的 UUID scratch Notebook（HTTP 201），并新建 session/kernel（session 请求 HTTP 201）；确认长执行已输出唯一 `probe-started` 标记后调用 provider `handle.interrupt()`。provider 中断得到确认，host `AbortSignal` 到达 handler，随后对该 scratch kernel 的 `/interrupt` 返回 204。该次 shell 执行返回 `error/KeyboardInterrupt`，同一执行收到 IOPub `idle`。handler 将 stdout 与中断错误写回同一 cell，Contents PUT 返回 200；GET 回读验证 cell ID、源码、起始输出和 `KeyboardInterrupt` 一致，且 `probe-late` 未出现。session 与 Notebook 删除都返回 204，最终 inventory 恢复基线 9 sessions / 9 kernels，匹配临时资源为 0。此证据证明本次 Codex 探针的一次性 host handler 可把 turn interrupt 传给远程 kernel、观察执行终止并保存/回读同一 cell 输出；它仍不验证产品 Jupyter 适配器、飞书 `/stop`、人工/Agent 执行协调、RTC、页面关闭后台执行或完整研究闭环。

### 用户 JupyterLab 扩展清单复查（2026-10-02）

使用 `.env` 中的 JupyterLab 凭据只读查询当前用户服务：`GET /api/status`、`GET /lab/api/extensions` 和 `GET /api/kernelspecs` 均返回 200；状态报告 2 个连接、9 个 kernel。扩展清单中 `datalayer-jupyter-server-nbmodel`（0.1.1--alpha.4）与 `datalayer-jupyter-mcp-tools`（0.1.6）的 status 为 `ok`；`jupyter-collaboration-extension`（4.4.1）、`jupyter-docprovider-extension`（4.4.1）和 `jupyter-notebook-lab-extension`（7.5.7）均为 installed/enabled，status 为 `error`，且 latest_version 为 null。kernelspec 清单只有 `conda-base-py`。

`/lab/api/extensions` 返回的是 JupyterLab Extension Manager 的 IEntry 包元数据；其 [官方接口](https://jupyterlab.readthedocs.io/en/stable/api/interfaces/extensionmanager.IEntry.html)将 `enabled`、`installed_version`、`latest_version` 与 `status` 定义为扩展安装清单字段，`status` 是已安装扩展状态标志，不带运行时错误详情。因此这些 error 标志不能证明浏览器模块加载失败，也不能证明 RTC 正常。下方单独记录的双页面 scratch 探针验证了用户服务的 RTC 同步；扩展清单本身不提供这一证据。该只读复查没有读取 Notebook/session 列表、打开页面、创建或停止 kernel，也未修改用户服务数据。

### 用户 JupyterLab 双页面 RTC scratch 探针（2026-10-02）

使用 `.env` 中的 JupyterLab 凭据先通过密码表单认证，再在隔离的 headless Chrome 临时 profile 中打开页面。通过 JupyterLab URL 为两个页面分别使用新建的命名 workspace，避免恢复默认 workspace；两个 workspace 打开同一唯一 scratch Notebook。服务状态基线为 2 个连接、9 个 kernel；只创建随机命名的 scratch 目录和单 cell Notebook（两个 Contents API PUT 均返回 201），未打开任何既有 Notebook，也未执行 cell 代码。第一页通过 CodeMirror 编辑器输入唯一标记；第二页从 RTC 共享文档实时读到该标记，而紧接的 Contents API GET 仍只返回最初源码，证明本次用户服务上的前端编辑经协作 WebSocket 对另一个页面可见、且当时还未写入序列化 `.ipynb`。观察到 `/api/collaboration/room/json:notebook:<file-id>` 与 global awareness WebSocket。

浏览器同时观察到多个 `/api/kernels/{id}/channels` WebSocket URL（探针期间共有 10 个 channel URL，基线已有 9 个 kernel，另有本次 scratch session）。没有检查这些 channel 的帧，也未向它们发送执行或中断；因此这里只报告连接建立，不推断其内核消息影响。关闭临时页面后，scratch session、两个命名 workspace 与 scratch 目录删除均返回 204；认证后 `/api/status` 回到 2 个连接、9 个 kernel。此结果是自动化浏览器对用户服务 scratch 文档的前端 RTC 证据，不是人工验收或 disclaude Agent/Feishu 闭环；输出保存、页面关闭后执行、关闭再打开恢复、执行所有权及既有 kernel 的端到端隔离仍未验证。探针使用命名 workspace 与单独页面的依据见 [JupyterLab URL 与 workspace 文档](https://jupyterlab.readthedocs.io/en/latest/user/urls.html)。

### nbconvert HTML 导出安全门槛（2026-10-02）

[Jupyter Server 官方安全公告](https://github.com/jupyter-server/jupyter_server/security/advisories/GHSA-fcw5-x6j4-ccmp)说明，2.19.0 及更早版本的 nbconvert HTML handler 缺少 `Content-Security-Policy` sandbox；打开由含用户 HTML 输出的 Notebook 生成、且托管在 Jupyter 同源下的 HTML，可能导致脚本以该服务源运行并访问其 API。该问题在 Jupyter Server 2.20.0 修复。此前记录的用户服务版本为 2.19.0，因此本版不能把该实例的默认 `/nbconvert/html/{path}` 响应作为可执行预览链接投递或在已登录浏览器中打开；本次没有请求或打开该 HTML 路由。

Jupyter Server 2.18.0 增加了 GET `/nbconvert/html` 的 `sanitize_html` 选项，[当前 API 文档](https://jupyter-server.readthedocs.io/en/stable/api/jupyter_server.nbconvert.html)将其说明为对 HTML 输出进行 sanitize；但这不替代 sandbox 响应头，也不能作为受影响 2.19.0 默认路由的安全证明。发行栈的首选门槛是固定到已修复版本（至少 2.20.0），并在实际生成的响应上核验 CSP sandbox。若将 sanitizer 作为兼容旧版本的额外降级路径，须在隔离样例中验证 query 参数、HTML/JavaScript 输出、图表 MIME 保留和响应头；在验证前禁用该路径。报告 HTML 的下载/附件投递与同源浏览器预览分开验收，不在 Feishu 消息中传递复用型 Jupyter 管理凭据。

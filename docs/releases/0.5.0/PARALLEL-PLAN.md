# 0.5.0 剩余实现与独立 PR 执行计划

制定时间：2026-09-09。基线：`987e4b91d5fbe804729eba12e72785a3aa7758ca`。
范围与验收编号沿用 [SPECS.md](SPECS.md)，本计划明确实现顺序、责任边界和交付物，不降低任何 P0 门槛。
用户已授权编写计划、启动并行 `gpt-5.6-sol` agent、实现修复并分别提交独立 PR；未授权合并、发布、部署或重启现有服务。

## 基线事实

- main 的版本号是 0.5.0，但功能未完成；旧 RC 的检查属于旧 SHA。
- 本次基线构建、类型、lint、10 文件 313 项定向测试通过，远端 CI success；未完成真实后端/渠道/部署验收。
- 预设 resolver 尚未接入 Agent 创建；DeepSeek provider 对话和工具仍抛未实现错误；Codex 尚无 steer 控制闭环。
- 脚本调度 PR #4851 已存在，不能另起重复实现；先审阅复用，再处理剩余上下文工作。
- 矩阵 PR #4849 已关闭且未合并，旧文档的 open 状态已过期。
- 本地配置已切换 gpt-5.6-sol；不提交含凭证的配置。原工作区未提交文件不进入任何 PR。

## 并行安排与共享契约

最多三个执行 agent 同时运行，均固定使用 gpt-5.6-sol。协调者维护计划、接点与验收记录；一个 agent 完成后接下一项，不以首批三项覆盖整版。
所有任务在独立 worktree、独立 feature branch 工作。每个 PR 只有一个代码主题，目标 main；有真实代码依赖时可以建立明确的 stacked PR，并在正文列出前置 PR，不能复制其他主题的提交。

| 顺序 | 工作流 | 文件主责 | 独立 PR 交付 |
|---|---|---|---|
| 第一批 A | S01 运行时预设 | config、AgentFactory、pool、预设命令与其路由 | 默认项真实接线；按 chat 查看/选择；忙碌拒绝与失败回滚 |
| 第一批 B | S02 DeepSeek | sdk/providers/deepseek 及针对性测试 | provider→transport→统一事件，工具输出、取消与进程生命周期 |
| 第一批 C | S05 CLI/端口 | REST IPC client、channel-cli、HTTP 启动与地址传递 | 缺失地址诊断；动态端口传播；双实例/重启与跨 cwd CLI |
| 第二批 A | S03 Codex 控制 | Codex provider/runner、控制命令、ChatAgent 控制接点 | stop/queue/steer 能力与执行身份；恢复与迟到结果隔离 |
| 第二批 B | S06 上下文治理 | scheduling、history-manager、账本模块 | 复用 #4851；独立调度会话、预算注入、有限归档分主题提交 |
| 第二批 C | S07 harness 收敛 | Claude provider、MessageBuilder、对应配置/测试 | 有证据的 workaround/endpoint 清理与稳定提示结构 |
| 第三批 A | S04 最终交付 | StreamingReplyDriver、飞书 adapter、ChatAgent 交付接点 | 终态状态机与降级修复；并发、取消及无正文回归 |
| 第三批 B | S08 隔离/运维 | cwd、logger、launchd/Docker 隔离验收脚本 | 已有能力回归与缺陷修复；可重现安装/升级/回退验收入口 |
| 协调及最终批 | S09 RC | 验收矩阵、发布文档、CI gate | 如实的矩阵与阻塞 gate；纠正 Changelog，汇总候选证据 |

S01 独占首批共享配置与 Agent 创建链。S02 若需公共 SDK 接口修改，先发契约给协调者；S05 首批不修改 AgentFactory/ChatAgent。后续 ChatAgent 修改按 S03→S06 集成接点→S04 排队。S07 不并行改其他任务已声明的历史/控制路径。
共享 npm workspace 安装/构建产物不得通过共享 node_modules workspace 链接串到其他 worktree；每个 worktree 独立安装与构建。

## S01：命名预设进入真实会话

1. 跟踪 loader→Config→AgentFactory→BaseAgent→SDK factory，明确默认预设优先级与旧 agent 配置兼容。
2. 实现单一配置解析入口，让实际 provider/model 与命令回显一致；不能仅增 resolver 测试。
3. 按 chat 存储选择，提供查看当前值、列出预设及选择命令。重启后的持久性必须说明。
4. 忙碌会话先明确拒绝；验证候选 backend/model 后再替换会话，失败保留原会话；跨后端创建新原生会话，明确上下文边界。
5. 回归 S01-A1–A4：默认/旧配置、未知预设、失效 provider、双 chat 隔离、忙碌拒绝、真实构造参数、pi 原有工具行为。

## S02：DeepSeek 对话与工具闭环

1. 从现有 transport/session pool/event adapter 接线，核实真实 dsh 协议与启动方式；不得凭空发明方法名并用同一假实现自证。
2. queryStream 将输入转为 RPC，将文本/工具/完成/错误转换为统一 SDK 事件；响应关联、完成一次与释放资源覆盖真实子进程测试。
3. 核实工具契约：本机 dsh 0.1.2-rc.1 仅有原生工具事件，没有外部 inline/MCP 工具注册与结果回送 RPC。适配原生事件；不支持的工具限制应 fail closed，不虚构协议。外部工具桥接保持未完成，等待实际协议支持。
4. 覆盖分片/乱序/EOF/进程失败/取消/恢复和重复终态；缺二进制、认证、profile 可操作报错。
5. S02-A4 真机验收另记：版本、单/多轮、工具文件产物、错误路径与最终投递回执。无真实环境标 blocked，不能用 fixture 代替。

## S03/S04：运行中控制与可靠交付

1. 验证输入 messageId、执行 ID、attempt、投递 ID 的关联；补 A/B 乱序、取消后迟到完成、重复完成行为测试。
2. queue 不中断当前回合；stop 确认后取消旧 attempt 的后续工具/重试/输出，同时保留可继续交流的上下文。
3. Codex 0.153.4 app-server 支持 turn/steer，但 exec JSONL 不暴露可操控的活动 turn。先交付真实 stop/queue 与明确的 exec capability 限制；再按可选 app-server transport、thread/turn 生命周期、真实 steer 拆分增量 PR，保持默认 exec 兼容。新进程恢复旧 thread 不能冒充对活动 exec 的 steer。
4. 记录停止确认与子进程退出时延，说明不能中止的操作边界。
5. 流式交付覆盖 thinking→replying→done，按 chat 节流；429、更新失败、finalize 失败降级，成功/失败/取消/工具后无正文均交付一次可见终态。
6. 保留原子去重与完整诊断，按最新 #4398 决策确定参数；真实卡片/普通消息回执单列外部证据。

## S05：分发与端口

1. 跟踪监听 port=0→实际地址→受管子进程 env→REST client；消除对历史端口的隐式依赖，公开固定端口配置仍可明确使用。
2. 独立 CLI 通过 --base-url 或环境显式配置；缺失/非法地址、认证失败应清晰报错，不记录 token。
3. 启动就绪后发布地址；重启新进程使用新地址；不假设环境变量逆向更新父进程或跨容器传播。
4. 启动两个隔离真实实例，验证地址、认证与消息路由不串；重启一个，另一个不受影响。
5. npm pack dry-run/临时安装，在仓库外 cwd 验证 help、send、push 的执行及结果，不只检查打包清单。

## S06：脚本调度及上下文预算

1. 审阅 #4851 的 prompt/script 互斥、执行取消、stdout/stderr、失败计数、冷却与时区覆盖；有缺口做独立补丁，不重写已有 PR。
2. 空轮询断言零 LLM；变化通过统一 push 唤醒，校验真实工具/最终交付。
3. 明确 fresh session、history skip、clearContext 兼容语义；调度不能悄悄重置用户活动会话。
4. 历史只在实例首条消息按预算注入；多 tick、恢复与重启验证次数及大小上限。
5. 活跃账本保留阈值、幂等归档、恢复与索引必须有行为测试；旧数据保留，不重新全文加载归档。
6. 合法 model/tier/预设进入实际执行，非法配置报错；形成旧配置迁移实例。按调度会话/历史预算/归档三个主题拆 PR。

## S07/S08：工程与部署

1. SDK 已升级至 0.3.263，核验实际依赖及升级回归；不重复 bump。
2. 为 workaround 记录原 issue、上游状态、保留/删除依据和单一入口；空流/瞬态错误/中断不得引入重复重试。
3. 稳定提示与动态输入分离，用请求结构对比验证；真实缓存收益未测则不宣称。
4. 清理失效 endpoint 的配置、模板和测试，保留可操作迁移提示。
5. 在隔离目录验证双项目 SDK cwd、缺目录拒绝、重启/项目切换；在临时日志目录触发轮转，核对保留量、stdout 与退出完整性。
6. Docker 和 launchd 均需隔离 install→start→health→upgrade→rollback→stop 演练；禁用真实飞书凭证和生产 workspace，使用唯一 service label/端口。
7. 缺 Docker/macOS 环境时仍交付可执行验收入口与本地可测部分，保留对应环境 blocked，不触碰现网。

## S09：证据与发布判定

覆盖 SPECS 的全部 Sxx-Ay；backend/deployment 变体逐项列出。每项记录 implementation（missing/partial/wired）、check（not-run/pass/fail/blocked）、测试文件/用例、可执行命令、退出码、候选 SHA、环境、预期/观察结果和证据路径。
矩阵 schema 校验与行为执行分开；必需 planned/blocked/skipped、缺证据或不存在的测试入口必须阻断 release gate。PR 提交不代表已合并，局部单测通过不代表整个 SPEC 完成。

每个实现 PR 运行关联测试、build/type-check、lint；最终统一候选执行完整单测与 70% coverage CI。受影响的后端与部署场景重验，旧 SHA 证据只在明确未受影响时复用。
纠正 Changelog 的已发布/全实现断言，保留历史证据归属；版本号保持现状，不重复 bump。根包 private、GitHub 分发策略不变，不把 npm publish 当验收。
最终提交待审 PR 清单、依赖图、已验证/仍阻塞条目。真实服务凭证、后端登录、评审合并和发布不通过自动扩大授权解决。

## PR 与运行记录

每个 PR 正文：具体问题和行为变化；Related issue/SPEC；依赖 PR；测试命令及结果；明确未验证的外部场景。仅完整解决 issue 才用 Closes。
优先小而完整的实现；跨层接线确需超过仓库建议的 3 文件/200 行时说明理由，避免将不可运行半成品拆成假独立 PR。
协调者维护本地 `.local/release-0.5.0/STATE.md`，worker 各写独立 evidence；状态不提交，凭证不写入文档或日志。
GitHub JWT auth skill 已按仓库 owner 匹配 GitHub App installation，获取仅限当前仓库的临时 token；通过 gh 执行 GitHub 操作，token 只保留在 gitignored runtime env，约一小时到期后刷新。无法创建远端 PR 时精确记录分支、提交及阻塞原因，不冒称 PR 已创建。

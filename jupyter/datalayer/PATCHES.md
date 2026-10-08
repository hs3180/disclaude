# Datalayer 补丁为什么需要保留

#5276 修复的是用户配置实例中已经复现的执行和输出错误。2026-10-05 升级至
nbmodel 0.2.9、其 Lab bundle 0.2.8、MCP 2.2.3、collaboration 5.0.4、
server-ydoc 3.0.4 和 Lab 4.6.4 后，下面六个场景仍然失败。因此，单纯安装
这一组升级版本还不能完成 0.6.3 的研究闭环；此 overlay 补齐现有接口，
继续使用原来的 nbmodel 队列、RTC/YNotebook、Contents 和 nbconvert。

判断依据限于这组已捕获源码和配置实例，不代表其他或未来 Datalayer 版本
也有相同问题。原始失败与后续复验分别保留在
[实例实测记录](../../docs/designs/datalayer-mvp.md#更新后实例复验历史2026-10-05-utc上海时间跨至-10-06)。

## 六个失败对研究工作的影响

| 问题与对应任务 | 未修复时会发生什么 | 本 PR 的处理与重要性 |
| --- | --- | --- |
| 后台输出未落盘：[#5262](https://github.com/hs3180/disclaude/issues/5262) | 所有文档客户端断开后，67 秒运行成功，原请求有 stdout，重新打开的 Notebook 却没有输出。报告和研究文件缺少已经计算出的结果。 | `actions.patch` 用受支持的 `get_document(create=True)` 加载共享文档，`server-config.json` 保留初始化的 room，由原生 ydoc 保存。后台计算无需浏览器或宿主 RTC peer 永远在线；这是后台研究的必要条件。 |
| 终态查询消费结果：[#5263](https://github.com/hs3180/disclaude/issues/5263) | 第一次 GET 后结果被删除，第二次返回 404。Lab 或另一个消费者先读时，尚未缓存的宿主也无法恢复结果。 | `execution_stack.patch` 与 `runtime.py` 将 GET 改为保留期内非消费查询，保留原请求及来源。宿主缓存只能保存它已经读到的结果，无法单独修复这个服务端问题。 |
| 请求取消误停其他运行：[#5264](https://github.com/hs3180/disclaude/issues/5264) | 取消 queued B 会中断 running A；取消 finished-unread A 又会中断新 running B。`DELETE` 成功并不说明停的是指定任务。 | 队列撤销只留下该请求的取消记录；已完成请求不发中断。运行目标校验队列当前请求与受管进程 PID，在锁内协调中断和派发，等待原生 readiness 后才继续。否则 `/stop` 会损坏其他计算。 |
| 旧输出附到新源码：[#5265](https://github.com/hs3180/disclaude/issues/5265) | 运行期间源码变化，cell 已显示新代码却仍附旧代码的 stdout，没有历史来源标识。Notebook 或报告会把结果归给错误代码。 | `OutputContext` 记录稳定 cell、原源码/hash、request 和原生 kernel incarnation；失配时停止写回当前 cell，原请求仍保留历史结果。cell 移动后重绑监听，删除后不写入别的 cell。这保护研究结果归属。 |
| display 更新丢失：[#5266](https://github.com/hs3180/disclaude/issues/5266) | kernel 已发出 `update_display_data`，原请求和共享 cell 仍保存初始 MIME。动态更新的表格或图可能以旧值导出。 | `actions.patch` 的输出处理与 `runtime.py` 的 display 注册表更新同一 Notebook 中同一 display ID 的多个位置，包括跨 cell 更新。保持原请求和共享文档的结果一致。 |
| clear wait 提前清空：同属 [#5266](https://github.com/hs3180/disclaude/issues/5266) | `clear_output(wait=True)` 后、替换输出到来前，旧输出已经消失。最终快照正确也不能证明运行中的显示正确。 | `wait=True` 延迟到下一个新增输出再清空，`wait=False` 立即清空，同时处理原结果与共享文档。恢复原生输出协议语义，避免运行中出现错误空白。 |

源码/输出保护保留为执行正确性条件。用户已将**手工 JupyterLab 修改支持及其
人工验收排除出 0.6.3**；相关合成 RTC 回归不能改称人工体验通过，也不增加
本版的手工修改交付要求。

## 为什么还需要 Lab 前端补丁

服务端写入 RTC 后，原有 Lab 客户端还会通过 HTTP 轮询、页面恢复和兜底逻辑
补写 cell。只修服务端时，客户端仍可能把旧响应写回已经变化的 cell；即使
没有手工编辑，另一请求更新的 display 也可能被较早的 HTTP 快照覆盖。

`frontend-source.patch` 在 `executionMetadata.ts`、`executor.ts`、
`requestServer.ts` 和 `plugin.ts` 的恢复入口加入同一个检查：cell/source、
request、incarnation 和输出版本必须匹配；历史结果、截断预览和较旧的输出
不得覆盖当前完整结果。原请求仍可查询，清理其运行标记也不能清掉新请求标记。
这使已修复的服务端结果能够与现有 Lab 恢复逻辑共存，不是新建 Notebook 编辑器。

三个产物补丁是这一前端修改的部署配套，不是三个额外产品 feature：

- `lab-bundle.patch` 把上述 TypeScript 修改应用到已安装、已核验的 JS bundle。
  `frontend-source.patch` 供源码评审；安装器实际应用的是 bundle 补丁。
- `lab-loader.patch` 将 loader 指向新 bundle 文件名。
- `lab-package.patch` 将 Lab extension 的入口指向新 loader。文件名带新 hash，
  避免原文件的浏览器缓存继续加载旧逻辑；改动产物移除已失效的 source-map 链接。

## 其余文件分别承担什么

| 文件 | 职责 | 是否可以单独省略 |
| --- | --- | --- |
| `runtime.py` | 共用的结果留存、取消状态、源码/输出归属、display 注册和 incarnation 读取。 | Python 补丁直接导入它，不能只安装补丁而省略模块。它不是另一个执行服务。 |
| `actions.patch` | 共享文档加载、实际执行 worker、输出协议与取消后续行。 | 六个失败中的执行/输出修复入口。 |
| `execution_stack.patch` | 原请求的非消费查询、全局配额、目标取消、完整大结果的 Contents 产物及只读能力声明。 | 修复原请求 API 行为，不能由宿主补偿全部替代。 |
| `handlers.patch` | 在现有路由公开执行政策，限制输入，返回过期 410、配额 429 和不可核验目标/队列 409。 | 与服务端策略配套，使客户端能确认能力并区分拒绝原因；不添加新的执行路由。 |
| `extension.patch` | 将可配置 TTL/配额/预览大小及 Contents manager 传给执行栈；修正停服时对私有栈的属性检查和释放。 | 让策略真正接入扩展生命周期。 |
| `server-config.json`、`configure.py` | 使用共享 Jupyter 配置加载 room 保留与结果策略，合并时保留其他配置。 | 后台保存依赖 room 保留；具体限额是部署选择，不是协议要求的唯一数值。 |
| `manifest.json`、`install.py` | 固定上游输入/补丁输出 hash；应用前核对全部内容和 Python 语法；拒绝未知源码，支持只读检查。 | 对直接修改已发布包的交付方式提供来源和漂移检查。仅在新镜像或自有临时树使用。 |
| `bin/jupyter-patch.js`、`jupyter-terminal.js`、`deploy.py`、`environment.py` | Node 生成上游修复产物，通过现有 Jupyter 登录和 Terminal 安装。保存原文件与候选文件，校验后安装/回滚磁盘内容，并合并指定配置。 | Terminal 是唯一安装入口；Docker、SSH 和服务管理适配已移除。安装明确返回需要外部重启，未声称热激活或运行中验收通过。底层修复源码和 hash 不变。 |
| `README.md`、`LICENSE.nbmodel` | 说明 Terminal 登录、安装、外部重启、回滚、原生文件身份和科学计算环境边界，并保留上游许可。 | 来源、许可、回滚和数据保留必须落实；科学计算依赖由现有 Jupyter 环境管理。 |

当前部署策略是终态保留一小时、全局最多 512 个 active/unexpired 请求、
输出内联阈值 64 KiB、源码输入上限 256 KiB。前三项经 trait 配置加载并由 API
声明，源码上限在 handler 中固定。配额满时拒绝新请求，避免挤掉未过期历史；
大终态结果写为认证 Contents 产物，预览明确标记截断，存储失败明确报告。
这些是资源与诊断策略，不是将上述数值本身作为业务保证。

room 保留会占用内存，需要保存完成后的维护重启来回收。终态 TTL 不删除已保存
的大结果文件；这些文件作为研究产物由用户管理。保留期外的 404/410 都不能证明
代码从未执行。

## 如何核验这些解释

按上述失败顺序，先阅读实例实测记录的
[升级后失败](../../docs/designs/datalayer-mvp.md#更新后实例复验历史2026-10-05-utc上海时间跨至-10-06)，
再看 [候选首轮](../../docs/designs/datalayer-mvp.md#修复候选第一轮复验2026-10-06-utc)
与 [组合复验](../../docs/designs/datalayer-mvp.md#第二轮组合复验2026-10-06-utc)。
记录区分真实配置远端的复验、故障注入、宿主组件与完整飞书产品验收，保留各轮失败。

本 PR 自带的回归可直接对应代码：

- [runtime tests](../../tests/jupyter/datalayer-runtime-test.py)：34 项，包括重复 GET、
  配额/大结果、queued/finished/running 取消、完成竞态、readiness 失败、incarnation
  变化、display/clear、源码变化和已清理文档加载。
- [实际 bundle 检查](../../tests/jupyter/datalayer-frontend-test.mjs)：16 项，运行补丁后的
  JS 模块，检查旧请求/旧源码/旧输出版本/截断预览拒绝写回，以及恢复逻辑不覆盖新执行。
- 2026-10-06 拆分验证在现有远端镜像的自有临时树应用并核对 manifest 的 8 个文件，
  上述 34/16 项均通过；运行中的包、配置和 kernel 未改动。这是组件证据，
  不能代替原生浏览器或人工 Lab 验收。

manifest 的 revision 为 `0.6.3-nbmodel-repair-2`，只读 API 政策标签仍为
`0.6.3-nbmodel-repair-1`；来源认定应使用 manifest SHA-256
`db82f9d7efd5f4886465b79e1e84b74d58858ee11f894761ac96156d299a8e4b`，
不能只看名称或标签。

## 本补丁的边界与后续替换

结果查询状态仍是进程内数据，Jupyter 重启后可能丢失；落盘 Notebook 和完整
Contents 产物与查询状态分别处理。本补丁不恢复 kernel 内存、不提供多 Service
控制权交接、服务端原子源码 CAS、永久迟到 POST fence 或跨系统 exactly-once。
这些强化条件由 [#5267](https://github.com/hs3180/disclaude/issues/5267) 后续评估。
当前路线使用单个 Service writer；目标取消的隔离范围是 nbmodel 队列管理的
原生 kernel，不覆盖其他客户端绕过队列直接向同一 kernel 提交的并发执行。
受管 PID 无法核验时拒绝运行中断；转发至另一个 Jupyter 的 proxy kernel 没有
经验证的精确中断路径。取消后的 readiness 无法确认时，保留原结果并停止该队列
继续派发，而不是声称同内存续行成功。

这些修复可以提交上游或被后续正式版本替代。替换某组补丁的条件是：在配置实例
通过对应原失败、边界回归及所需产品场景，同时重新核对实际发布源码和依赖。
仅看到版本号提高或接口存在不足以删除修复；也不应在新版本上强行套用旧 hash。
本 PR 的来源固定和回归让逐项退出 overlay 可以被验证。

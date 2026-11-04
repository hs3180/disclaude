# 多维表格任务看板

看板可以单独使用：不需要启动 Goal loop 或 agent，用户和主 agent 都能通过现有 `lark-cli base` 创建、查询和更新任务。服务不另建一套飞书 SDK、凭据存储或看板调度器。需要已有的 `lark-cli` 和相应 Base 授权；按操作者的既有身份操作。

## 建表

在仓库根目录执行，或将 [字段模板](../examples/task-board/fields.json) 保存到自己的 Project。使用已有 Base 时先解析链接、读取表和字段，复用已有内容；不要覆盖用户自定义字段。

```sh
lark-cli base +base-create --as user \
  --name 'Project 任务看板' --table-name Tasks \
  --fields "$(cat examples/task-board/fields.json)" --dry-run
```

核对目标和字段后去掉 `--dry-run` 执行一次。保存返回的 `data.base.base_token`、`data.base.url` 和 `data.table.id`，后续直接使用这些坐标。不要为了恢复会话再建一张表。这个 CLI 创建自定义首表时会替换它刚创建的空默认表。

模板只包含九个普通字段：任务 ID、Goal ID、任务、验收要求、状态、负责人、产物、Review 依据、等待问题。负责人是可读的 worker 标识或人名文本，不依赖通讯录。状态为待办、执行中、等待人、待 review、返工、完成。Goal ID 可留空；各能力能够独立使用。

将真实 Base 和表 ID 设为本次命令的变量，先读取实际字段：

```sh
task_board_base_token='<返回的 base_token>'
task_board_table_id='<返回的 table.id>'
lark-cli base +field-list --as user \
  --base-token "$task_board_base_token" --table-id "$task_board_table_id"
```

## 新增、查询和更新任务

由发起者为任务分配稳定的任务 ID，例如 `report-data-01`。第一次创建前，按该 ID 查询；下例将结果保存到当前 Project 的本地文件。

```sh
lark-cli base +record-list --as user \
  --base-token "$task_board_base_token" --table-id "$task_board_table_id" \
  --filter-json '{"logic":"and","conditions":[["任务 ID","==","report-data-01"]]}' \
  --format ndjson --output ./board-before.ndjson
```

确认 `has_more=false` 且没有已有记录后，创建一次：

```sh
lark-cli base +record-upsert --as user \
  --base-token "$task_board_base_token" --table-id "$task_board_table_id" \
  --json '{"任务 ID":"report-data-01","任务":"核对报告数据","验收要求":"列出数据来源和缺失项","状态":["待办"]}'
```

保存成功响应中的 `data.record.record_id_list[0]`（以当前 CLI 实际响应为准）。`record-upsert` **不会按任务 ID 自动去重**：没有 `--record-id` 就是创建新记录。查询任务 ID 也不是原子去重；初始建任务由一个拥有者串行执行，发现多条同 ID 记录时先核对，不再追加。

以后更新同一记录时始终带上它的真实 ID，只提交本次要修改的字段：

```sh
task_board_record_id='<返回的真实 record ID>'
lark-cli base +record-upsert --as user \
  --base-token "$task_board_base_token" --table-id "$task_board_table_id" \
  --record-id "$task_board_record_id" \
  --json '{"状态":["待 review"],"负责人":"worker-a","产物":"reports/data-check.md"}'
```

Select 字段写名称数组。`--json` 是字段映射，不额外包一层 `fields`；输入值使用 JSON 编码，不把用户内容拼成 shell 代码。较长数据按所用 CLI 版本支持的文件或 stdin 方式传入。

一批相关变更结束后统一查询验收。结果可能异步可见；写成功后暂时查不到，不等于写入失败。使用新的输出文件或明确保留/替换旧查询 artifact。

```sh
lark-cli base +record-list --as user \
  --base-token "$task_board_base_token" --table-id "$task_board_table_id" \
  --filter-json '{"logic":"and","conditions":[["任务 ID","==","report-data-01"]]}' \
  --format ndjson --output ./board-verification.ndjson
```

## 与执行、review 和等待组合

主 agent 在启动任务前读最新任务和验收要求，执行后记录产物，再交给 reviewer 写通过或驳回的具体依据。等待用户时填入“等待问题”，其他已就绪任务继续；收到回答后只更新原任务。没有产物、验收或 review 依据时，不把任务列为完成。

这些是协作约定；普通 Base 写入本身不会验证产物、唤醒 agent 或执行返工。多个 worker 的独占认领需使用另行接入的版本校验/认领能力，再将拥有者和状态投影到表里。不能把“先读到待办，再写执行中”当成并发安全的认领，也不要把 Base 的请求成功回执当成 Goal 已完成。

## 失败与恢复

写操作检查 CLI 退出码和 JSON 的 `ok`，保留响应及原始记录 ID。NDJSON 查询成功时返回 manifest，不带 `ok`；按退出码、`records_count`、`has_more` 及导出文件核验，不能因缺少 `ok` 重复写入。网络中断或回执不明时，先按已知记录 ID/任务 ID 查询真实状态；不盲目重发创建。授权失败按现有操作者恢复授权，不静默切换为 bot。保留用户编辑和其他字段，冲突时重新读取并核对；Base 普通记录更新没有这里所需的 CAS 保证。

独立验收只需一张新表、一条带稳定 ID 的测试任务：先查询确认不存在，再创建、按返回 ID 更新、统一读回；要求字段和记录数一致且任务没有重复。多 agent 认领、自动 review/返工和完整 Goal 图景分别验收。

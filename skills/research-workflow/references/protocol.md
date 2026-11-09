# 飞书研究文档读写参考

在处理文档反馈或修订已有报告时，使用本参考保护用户内容并确认实际同步结果。按任务需要读取和核验；不要求每轮保存完整 API 响应或重复扫描无关材料。

## 读取反馈

先用当前环境的 Lark CLI help 核实文档与评论命令和身份选项，再读取报告正文及与本轮研究相关的评论/回复。若评论分页，读完所有相关页面；遇到读取失败、权限不足或未完成分页，应报告反馈同步不完整，不能把未读到当成没有反馈。

示例命令如下，具体参数以当前 CLI help 为准：

```sh
lark-cli docs +fetch --doc TOKEN --doc-format markdown --scope full --as user
lark-cli drive +list-comments --token TOKEN --type docx --comment-scope all --solved-status all --as user --page-size 100
lark-cli drive +list-replies --token TOKEN --type docx --comment-id COMMENT_ID --as user --page-size 100
```

按返回的 has_more 和 page_token 继续分页。根据评论所指段落及上下文理解意见；不能把评论单独摘出后脱离论证处理。

## 定点修改与核验

- 写入前确认当前正文仍包含将要修改的内容；若其版本或相关段落已变化，重新理解后再编辑，不用旧快照覆盖用户新内容。
- 优先对受影响段落做 targeted str_replace 或 append，不整篇覆盖文档，不重复追加不确定的写入。
- 写入后读回受影响段落及必要上下文，确认用户编辑、重要来源和修订内容仍在且相互一致。若服务返回不确定，先读取远端状态再决定是否重试。
- 不要用聊天回执、CLI 的本地成功提示或本地文件替代远端读回。未确认的内容要标为未确认/未同步。
- 研究启动请求不自动授予额外文档分享或权限变更授权。

## 全文评论处理完成后的通知

飞书全文评论（`is_whole=true`）不支持在原评论下追加线程回复。只有当本轮实质性修改确实应用了相关全文评论、评论及回复分页已完整读取、且修改后的正文已成功回读时，才在当前 Project 的合适飞书会话中通知原评论者。只通知本轮反馈相关的作者；按 `open_id` 去重后合并到同一条消息。评论响应中的身份字段不明确时，使用当前授权可用的唯一身份解析；无法唯一确认就不猜测、不发送。

用具体的修改说明和同一研究文档链接（必要时附相关位置），通过 channel CLI 的 `--mentions` 发送真实 mention，例如：

```sh
disclaude channel send_text --chat CHAT_ID \
  --text-file ./research-update.md \
  --mentions '[{"openId":"ou_example","name":"评论者"}]'
```

不要尝试对全文评论调用不受支持的原线程回复。若通知命令失败，保留已写入并回读确认的文档，不重放文档写入；在当前对话中说明文档已更新、回读已确认，但通知未送达。没有实质性修改或核验不完整时，不发“已处理”提醒。

## 输出文档评论按需监听（watch）

评论监控默认关闭：disclaude 服务不会自动监听任何文档。仅当你或用户明确希望继续跟进某份已交付报告的评论时，才按需开启监听会话；不需要时停止，不监听时没有任何后台轮询。

用 disclaude CLI 的 watch 指令管理（服务需在运行；受管 agent 已继承 `DISCLAUDE_API_BASE_URL` / `DISCLAUDE_API_TOKEN`）：

```sh
# 登记文档与当前 Project 会话的关联（显式登记才监听，未登记的文档不会被扫描）
disclaude research watch add --doc <docToken> --chat <当前Project会话> \
  [--type docx] [--project 报告主题] [--as user]
# 开启监听会话（--interval 秒，有效范围 10s–1h）
disclaude research watch start [--interval 300]
# 查看会话、检查点与错误报告
disclaude research watch status
# 停止会话（登记与检查点保留，之后可再 start 续听）
disclaude research watch stop
# 不再需要该文档的关联
disclaude research watch remove --doc <docToken>
```

会话语义：

- 只读取已登记文档的评论，以登记身份访问（默认 `user`，即当前用户可见范围）；未登记的文档永远不会被扫描。
- 会话首个周期做基线：开启时已存在的评论只记录、不重发；之后的新评论按文档/评论者/时间/原项目关联送回登记的 Project 会话，由你在原研究上下文判断采纳、需进一步核验并追问、或有依据地不采纳——watch 本身不修改文档、不答复评论。
- 检查点持久化：轮询重叠、重复评论事件、停止后重启会话都不重复送达；重新 `start` 从检查点续听，不重放旧评论。
- 评论读取或送达失败会显式记录并按指数退避重试，不静默丢弃；`watch status` 的 `recentErrors` 与各文档 `lastError` 可查。
- 收到评论事件后的修订遵循本参考「定点修改与核验」的方法，评论者通知遵循「全文评论处理完成后的通知」的边界；不要因为开了监听就自动改写报告或未经确认自动答复评论。

监听不是研究交付的默认步骤；服务未运行或未暴露 REST API 时上述指令会失败并给出原因，此时在当前对话中说明监听不可用即可，不影响已交付的报告。

## 可选完整快照工具

仓库脚本适用于评论很多、分页核验容易出错或需要比较大段修订的场景，不是每次研究的必经流程：

- `scripts/collect-feishu-snapshot.mjs`：完整收集正文、评论及回复分页并校验关联关系。
- `scripts/feishu-snapshot.mjs`：把完整原始响应转换为核验用快照。
- `scripts/write-feishu-text.mjs`：对明确选定的文本执行一次定点写入。
- `scripts/prepare-conclusion-replacement.mjs`、`scripts/verify-conclusion-history.mjs` 和 `scripts/compare-snapshot-history.mjs`：只在需要保留并比较较长历史结论时使用。

仅在本轮确有需要时将必要读回或研究产物保存到 Project；不要为证明每次同步而留下完整调用日志。原始资料和有复用价值的探索记录与人类可读报告分开归档。

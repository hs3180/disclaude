# 文档协作读写约定

研究文档正文和评论是协作状态。每轮开始和结束都用 Lark CLI 完整读取正文、全部评论及回复，并把成功的原始响应保存到任务私有目录；读取失败或分页不完整时保留上一次成功读回并明确说明。

```sh
lark-cli docs +fetch --doc TOKEN --doc-format markdown --scope full --as user
lark-cli drive +list-comments --token TOKEN --type docx --comment-scope all --solved-status all --as user --page-size 100
lark-cli drive +list-replies --token TOKEN --type docx --comment-id COMMENT_ID --as user --page-size 100
```

根据 `has_more` 和 `page_token` 读取每一页；不要把摘要当作完整评论，也不要把失败页替换为空列表。`scripts/feishu-snapshot.mjs` 只把已保存的成功 CLI 响应转换为统一快照，不访问远端。

结合正文上下文处理用户意见。实质修改采用增量写入并立即完整读回，确认用户原文、来源和新内容都保留。反馈无法在本轮处理时在文档或本地工作记录中明确标为待处理；不能把等待或本地检查当作已处理。

使用 `scripts/write-feishu-text.mjs` 进行 targeted `str_replace` 或 `append`，从 JSON stdin 传入原文和可选正文版本，避免 shell 解释反引号、`$()` 和换行。写入结果不明确时先完整读回再决定是否重试；不要盲目重复追加，也不要整篇覆盖文档。

实时读回的完成时间只能在所有正文、评论和回复页成功校验后记录；它表示本次采集完成，不是原子远端快照，也不是写入时间。最终回复给出文档链接、已确认变化、未解决意见和研究是否仍在进行；没有成功采集时间时明确未知，不制造时间。

本约定不创建任务管理器、调度器、文件索引或后台执行机制；本地目录只保存完成本轮读写所需的原始响应和研究产物。

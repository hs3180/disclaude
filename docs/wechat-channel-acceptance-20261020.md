# 微信 Channel 候选交付记录（2026-10-20）

结论：已交付可独立安装的个人微信 iLink 候选包，并完成本次真实手机扫码登录。隔离实例已收到真实微信文本，实际 Codex Agent 执行完成，腾讯接受回复并返回消息 ID；用户随后明确确认“收到回复了”，基础文本收发闭环通过。指定内容与会话连续性、图片/文件闭环仍待分别验收。正式发布、合并及生产飞书服务升级均未执行。

## 可核验产物

| 项目 | 结果 |
| --- | --- |
| 主线基线 | `271948b38f9686be1ad3124932c3df94057f174d`（0.6.5） |
| 候选包 | `disclaude-0.6.5-wechat.d79885c05.tgz` |
| 包内源码提交 | `d79885c0580de9a3eb61465e1535e998e25ddad3` |
| 体积 | 971,128 字节 |
| SHA-256 | `d0e2540375f3543325d38c12855d942ba0b486480593511551a8812fab32f17f` |
| 源码指纹 | `b37c51acb8466cba1a6d7923d78e642ed20e9ba49612391b660774bf74eb63d9` |
| 独立安装 | 全新 prefix 中安装压缩包；未链接开发检出目录；通过 |
| 当前联调实例 | 从该压缩包安装，`wechat` 为唯一启用通道，Codex 模型 `gpt-6-luna` |
| 实例状态 | 认证 API 的 capabilities 返回 `running / healthy`，只声明 `send_text`、`send_file` |
| 原飞书服务 | 保持运行，健康探测 HTTP 200；未修改其通道配置或共享 `.runtime-env` |

安装包已通过本实施群的 channel 文件投递，CLI 返回 `ok: true`。包内带有 `release-source.json` 和[接入/恢复说明](wechat-channel.md)。详细测试日志保存在本任务的私有本地证据目录，不把账号文件、API 令牌、同步游标或签名媒体 URL 放进仓库。

## 实现范围

接入产品形态是腾讯 iLink 的**个人微信机器人会话**。认证使用扫码取得 bot token，消息由客户端主动 HTTPS 长轮询获取，没有公网回调或回调验签；不包含企业微信、公众号或微信群。

- 按当前 `msgs`、`message_id`、`create_time_ms`、`get_updates_buf` 协议收取消息，uint64 消息 ID 不经过 JavaScript 浮点数舍入。
- 入站失败交接可重试；成功交接后保存去重 ID 和游标。机器人回声不进入 Agent。回复上下文按微信用户私有保存，通用父消息 ID 不再充当微信令牌。
- 支持 iLink CDN 加密上传和下载，图片/文件通过通用附件抽象交给 Agent。文件类型使用当前协议的 4，避免把类型 3 的语音当作文件。
- 接入 `wechat login/status`、旧凭据迁移、配置校验、账号互斥锁、重启状态恢复和通道能力查询。失效码 `-14` 停止轮询并报告不健康；重新登录后可恢复。
- 文本按本地 4,000 UTF-8 字节分段，文件上限 20 MiB。超时/网络异常明确报告送达未知；部分文本已发送时报告部分送达，不盲目重试。
- 原生卡片、按钮、提及、群聊、语音/视频解码、多账号配置和流式编辑未实现，能力声明及 CLI 拒绝行为与此一致。

## 验证结果及边界

| 层次 | 已观察结果 | 不能据此声称的结果 |
| --- | --- | --- |
| 原问题复现 | 原代码上新增的 4 个协议/超时回归用例全部失败；修复后通过 | 不代表已进行手机侧收发 |
| 微信相关测试 | 126 个微信单元与协议集成用例通过；包含加密附件、真实 CLI/API 查询、重启去重、失效和部分送达 | 腾讯 HTTP 被拦截，Agent 交接使用测试替身 |
| 全量测试 | 清理继承的浏览器运行环境后，291 个测试文件、5,972 个用例通过 | 首次直接继承环境的运行有 9 个浏览器用例失败；没有把那次运行记为通过 |
| 启动修复后回归 | 62 个描述符、生命周期和协议集成用例通过；类型检查通过 | 全量通过记录早于最后的注册表/启动提示修正；这两处另由相关回归和包级启动检查覆盖 |
| 安装验收 | 最终压缩包通过 `PACKAGE_INSTALL_OK`、`CLI_START_STOP_RESTART_OK`，含微信配置进入真实启动流程、缺少登录时给出适配器错误的检查 | 安装成功不等于腾讯收发成功 |
| 真实登录状态 | 先验证并私有迁移旧登录；随后按用户要求重新生成二维码，2026-10-20 13:52（北京时间）扫码确认成功，自动恢复监听；候选包 `wechat status --check` 再次调用腾讯 `getconfig` 成功 | 本次未要求配对码；配对码流程与真实失效重登仍待验证 |
| 真实 CDN 独立探测 | 小文本文件和 1 像素 PNG 的加密上传均返回 200；用上传响应引用自行下载均返回 400，响应体为空 | 下载失败原因尚未定位；不能把上传成功记成附件闭环通过，也不能据此认定真实入站引用同样失效 |
| 真实运行 | 13:52:27 收到真实文本，实际 `gpt-6-luna` Agent 于 13:52:40 完成；腾讯接受回复并返回服务端消息 ID；此时去重计数 1、会话数 1，同步游标已落盘 | 未伪造或回放用户消息；服务端接受回复不代表手机已读或附件内容核验 |
| 手机侧反馈 | 用户在实施群确认“收到回复了”，与真实入站、Agent 完成、腾讯接受回复的记录结合，基础文本闭环通过 | 指定内容、会话连续性与附件收发不能由此替代 |
| 日志扫描 | 候选 stdout、stderr、服务日志中未检出已知 bot token、当前 API token 或已保存回复令牌 | 尚无真实入站媒体，不能声称覆盖所有服务端错误内容 |

首次完整测试中的 9 个失败都来自继承的浏览器 manifest/launcher 环境。去掉这组环境后，相关 3 个文件的 25 个用例通过；随后进行了完整的干净环境复跑，得到上述 5,972 个通过结果。没有修改浏览器实现来掩盖失败。

包含最终代码的 PR #5448 头部 `8260e00b1` 随后通过全部 8 项 CI（lint/type、单元、构建、安装、服务数据生命周期及其余检查）；补充 CDN 证据后的文档头部 `2ea024973` 也已通过全部 8 项。本次补充真实扫码与文本记录仍为文档更新，不改变已交付安装包。

## 实际启动发现的问题

首份 `0.6.5-wechat.3b3df9a4a` 候选能安装，但真实微信配置启动失败：`Unknown channel type "wechat"`。原因是历史动态注册限制仍留在服务的内置描述符目录，配置解析测试没有覆盖这一层。该包已标为拒绝交付，未发送给用户。

已将微信加入配置驱动的内置注册表，并在压缩包安装验收中加入真正的微信配置启动检查。第二轮检查还暴露了测试进程继承文件日志配置、无法从 stdout 捕获适配器原因的问题；已隔离日志环境。最后修正了“Feishu only mode”的旧启动提示。最终交付包与当前实例均为 `d79885c05`，启动输出实际为 `disclaude service started (wechat)`。

## 使用与后续验收

候选包建议安装到独立 prefix，保留当前生产安装：

```sh
npm install --prefix /absolute/path/to/wechat-candidate ./disclaude-0.6.5-wechat.d79885c05.tgz
/absolute/path/to/wechat-candidate/node_modules/.bin/disclaude wechat --help
/absolute/path/to/wechat-candidate/node_modules/.bin/disclaude wechat status --check
```

本机联调实例已完成本次新扫码，无需重复登录。用户随后反馈 Agent 找不到可见项目文件，因此已在宿主 `projects/wechat-channel-acceptance/` 项目（也就是微信实例实际 workspace）中补入 README、`docs/联调测试说明.md`、`scripts/wechat-check.mjs`、文本与四色 PNG 样本、脱敏报告和联调记录；实施群默认 workspace 根目录也增加可见索引。诊断脚本已实际运行，登录校验、服务健康、能力发现和样本校验通过。

下一步可在微信发送“请读取当前项目 README.md，并执行 node scripts/wechat-check.mjs --verify-login --write-report”，然后按项目说明逐项确认短文本、会话连续性、真实图片和文件的双向收发。这些测试需要手机侧实际操作；不以宿主伪造入站或 CDN 独立探测代替。图片和文件的真实 E2E 仍保持待验收。

当前实例由 `com.disclaude.wechat-acceptance-20261020` 独立 launchd job 管理，保持该任务的运行目录和账号目录。需停止时由宿主执行：

```sh
launchctl bootout gui/$(id -u)/com.disclaude.wechat-acceptance-20261020
```

不要把候选启动记成正式发布。补丁链从 [#5436](https://github.com/hs3180/disclaude/pull/5436) 起逐个依赖；[总需求 #4889](https://github.com/hs3180/disclaude/issues/4889) 保持未关闭。合并、正式安装发布、指定文本内容/连续性、图片/文件 E2E 和实际断网/失效恢复结果仍需分别记录。持久去重是有界缓存与原子检查点，不提供 Agent 入队与检查点之间的事务型 exactly-once 保证。

协议核对依据：[腾讯 iLink 协议类型](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts)、[腾讯 CDN 上传实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/upload.ts)。历史 [#3815](https://github.com/hs3180/disclaude/issues/3815) 的 URL 解析已复核，不作为加密媒体端到端通过的证据。

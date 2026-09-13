# 0.5.1 npm tag 安装验收

2026-09-11：正式 Git 标签 `v0.5.1` 已创建。GitHub Release 公开发布仍待 Docker 部署验收；不执行 npm registry publish。

## 制品锁定

- 合并后源码：`10cc7ecd258216436381471a9757aec2070cd0f8`（#4925）。[main CI](https://github.com/hs3180/disclaude/actions/runs/34569820926) 全部通过。
- 发行提交：`55cb48616bca0ac08e95af1e0c746f6daddcf982`。
- 正式标签：[`v0.5.1`](https://github.com/hs3180/disclaude/tree/v0.5.1)，指向上述发行提交，不指向源码 main。
- 源码指纹：`2539564935d40b6b312462c07130014ea5f9ecc3049b8227352cb5f9cec9f27e`。
- `packages/` 运行产物与 `bin/` 和之前八组安装验收的候选逐文件一致；文档、审查记录和源码来源已同步到合并后源码。新发行 SHA 已重新通过隔离安装和服务生命周期检查。
- 备用 `disclaude-0.5.1.tgz`：757797 bytes，SHA-256 `f50ab7476dd4fa3aa460190f0360a1c9e6e15a7a5d7088d157dc829fca52e9ba`。Node 22.23.2/npm 11.6.0 普通全局安装及服务启停/重启通过。

## Tag 验收命令

```bash
npm install -g "github:hs3180/disclaude#v0.5.1"
disclaude --version
disclaude start --help
disclaude channel --help
```

隔离验收使用环境变量指定临时 npm prefix/cache/userconfig，不替换用户现有全局安装。`--plain-install` 执行不带额外安装参数的上述 npm 命令：

```bash
node scripts/test-package-install.mjs github:hs3180/disclaude#v0.5.1 \
  2539564935d40b6b312462c07130014ea5f9ecc3049b8227352cb5f9cec9f27e \
  --prefix-from-env --plain-install
```

验收包括：包路径不悬空、没有 Husky/旧 bin/旧服务包、内置资源可加载、全部运行模块可导入、CLI 实际启动、HTTP `instanceId`、SIGTERM 停止、释放锁、重启及数据保留。

CI 从 fixture 读取 tag 和期望提交，先解析 tag（支持轻量及 annotated tag）确认指向，再执行 Node 20/22 × npm 10/11 四种组合。macOS 同样执行四种组合；每一组必须出现 `CLI_START_STOP_RESTART_OK` 和 `PACKAGE_INSTALL_OK`。本次最终逐组结果附在发布准备 PR 中，不能仅凭已创建 tag 宣称验收完成。

## 未完成的发布边界

Docker health-check 路径已修复并通过真实子进程匹配测试，launchd 安装/升级/回退演练通过；但本机没有 Docker，完整容器尚未运行实测。不得因此关闭 #4924 或宣布所有 0.5.1 发布目标完成。正式 tag 不再移动；如果后续发现发行缺陷，应另行决定修复版本，不覆盖已公开的制品。

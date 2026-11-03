---
title: 命令行
description: graft 命令及其子命令。
---

CLI 需要 Node.js 22.19 或更高版本，与 Effect Node 适配器的要求一致。

`@graftland/cli` 包提供 `graft` 命令。

## graft start

```sh
graft start [config] [--watch] [--env-file <path>]
```

运行[配置文件](../config-file/)中描述的应用。`config` 默认为
`graft.yml`。插件按文件中的配置加载，进程会持续运行，直到收到
<kbd>Ctrl</kbd>+<kbd>C</kbd> 或 `SIGTERM`，随后按顺序卸载所有插件。

`--env-file` 指定供 [`!env`](../config-file/#环境变量) 标签读取的 `.env`
文件，相对路径按当前目录解析。进程环境中已设置的变量优先于文件，即使值为空字符串也是如此。文件不存在时命令直接失败。使用
`--watch`
时，保存该文件会重新读取并让 loader 重试，值有变化的条目随之更新；文件读取失败时沿用之前的值。该文件提供给 Effect 的
`ConfigProvider`，`!env` 和插件自行读取的 `Config` 都从这里取值；它不会修改
`process.env`，直接读取 `process.env` 的库看不到其中的变量。

监听模式还会每秒重新读取请求路径，每次都重新解析符号链接。因此，目标位于配置目录外、链接改指向或原生通知丢失时，也能检测变化。只有内容改变才让 loader 重试；读取失败会记录错误并保留之前的值，轮询继续。原生监听失败后会记录错误并重装；关闭时的清理失败也会记录完整 cause。

不使用 `--watch` 时，初始配置无效会报告原始 cause，并以非零状态退出。使用
`--watch`
时，CLI 记录首次加载失败，继续等待合法配置，修正后无需重启进程。首次读到合法文档前，Loader 服务已可用，但条目为空；通过 API 编辑时仍须先验证磁盘文件，不能覆盖无效文档。

使用
`--watch`（`-w`）时，loader 单独监听 YAML 配置变化。只有配置目录及其子目录中已观察的
`.js`、`.mjs`、`.cjs`、`.ts`、`.mts` 和 `.cts`
文件内容或本地解析结果实际变化才会触发增量
[模块重载](../hot-reload/)，`node_modules`
中的文件会被忽略。编辑 YAML 不会重新导入所有入口或重启所有从模块加载的插件，也不会刷新未变健康项的环境值。移除或禁用配置项会释放模块租约，已不再使用的模块即使代码无效，也不会阻塞其他入口的重载；等待依赖或失败的配置项仍保留租约。轮询也跟随租约，保留失败导入以便重试，最后一个所有者关闭后不再读取入口及其独占依赖。原先共享的 Plugin 导出分化，或替换身份相互重叠、与历史 alias 不一致时，CLI 会列出冲突模块并提示重启，保持正在运行的插件不变。

首次导入失败后，观察租约仍由配置项持有，与立即关闭的候选资源 scope 分离。修正模块后，即使原生通知丢失，也能通过轮询恢复。重试替换观察代次，移除或禁用配置项则关闭观察 scope。

CLI 使用带模块文件过滤的
`hmr.watch`。原生事件会请求内容检查，只有实际变化才会增量重载受影响的入口，并保持共享模块一致。每秒检查元数据和本地解析结果，以 stat 快路径跳过无须读取的文件；空闲时至少每十秒核查一次内容，捕捉大小和时间戳均未变、通知也丢失的修改。HMR 按观察到的依赖图安装非递归目录监听，不遍历无关目录。每次重载尝试返回
`Reloaded` 或 `Skipped` 后，CLI 会调用 `loader.retry`，重试失败项并刷新整棵树的
`!env`
值。重载和 retry 的失败会记录完整 Cause，监听继续。watcher 的 I/O 失败也会被记录，并在一秒后重新安装 watcher。关闭 watcher 时也会观察失败：中断与错误或 defect 混合的 Cause 会完整记录，只有纯中断才作为正常取消处理。HMR 也会记录取消请求发出后才完成的原生导入失败，避免其被中断遮蔽。

日志以便于阅读的格式输出。插件写出的每行日志都带有插件名称和 fork
id。CLI 为配置项的 `intercept` 登记了
`effect/References/CurrentLogAnnotations`（与外层注解合并的对象）和
`effect/References/MinimumLogLevel`（替换最低日志级别），对该项及其子插件生效。
[配置文件文档](../config-file/#配置项字段)列出了合法值和示例；非法值让该项以
`InvalidIntercept` 失败。CLI 不登记其他 Reference。

## graft create

```sh
graft create <directory> [--name <name>] [--install]
```

在空目录或新目录中创建项目，包括 `package.json`、`graft.yml`、示例插件和
`.gitignore`。包名默认为目录名。项目依赖的 Graft 版本与创建它的命令版本相同，`graft.yml`
也指向该版本的 [schema](../config-file/#编辑器支持)。

使用 `--install` 时，创建后会安装项目依赖。

## graft add

```sh
graft add <package...>
```

为当前目录中的项目添加依赖并安装。每个包可以指定版本范围，例如
`graft-plugin-review@^1.2.0`；未指定时使用最新版本。

## graft remove

```sh
graft remove <package...>
```

从当前目录中的项目移除依赖。

## 包管理器

`add`、`remove` 和 `create --install` 使用项目的包管理器。Graft 依次从
`package.json` 的 `packageManager` 字段、锁文件以及运行 `graft`
的命令中判断包管理器；都无法确定时使用 npm。支持 npm、pnpm 和 Yarn，不支持 Yarn
Plug'n'Play。

从安装开始到结束（包括恢复过程），包管理器要求独占项目的写入权。运行
`add`、`remove` 或 `create --install`
期间，不要编辑项目文件或运行其他安装命令。同一个 PackageManager 的调用会串行执行；Graft 不会通过锁阻止其他管理器实例、编辑器或进程写入。

如果安装失败或被中断，Graft 会逐字节恢复已备份的包管理文件，包括 `package.json`
和锁文件，并删除安装前不存在、但属于恢复范围的文件。回滚会覆盖安装期间的修改，不检测冲突，也不合并编辑。

如果项目原本有当前包管理器的锁文件，Graft 还会尝试修复
`node_modules`。恢复错误会与原始失败一起报告。不承诺进程崩溃后的恢复。

受包管理器管理的文件必须是普通文件或不存在。符号链接（包括悬空链接）和其他文件类型会在安装写入前被拒绝。Windows 按现状提供（as
is）：进程树清理与回滚保证未经验证，不作承诺。

### watch 模式下需要重启的情况

版本化模块取得原生加载能力（导入 `node:module`，包括 `createRequire` 和缓存的
`require(esm)`），或本地入口、helper 符号链接更换目标时，CLI 会输出
`Restart required`，保留全部旧插件，不报告重载成功。符号链接目标也参与定期核对，因此内容相同和原生通知丢失不会隐藏目标变化。

已知的原生加载重启要求会在没有文件事件时主动报告，避免启动窗口漏通知后始终静默。周期性检查不会重复报告相同状态。

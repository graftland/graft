# Graft 性能基准

这是一个私有工作区包，用于比较 Graft、cordis、avvio、原生 Effect、Node
EventEmitter 和 emittery。先检查各实现完成的工作是否一致，再解读速度差异。报告把不支持的操作列为 N/A，并说明原因。

## 运行

所有命令都从仓库根目录运行。依赖和 pnpm 存储保留在当前工作树中。基准命令先构建 Graft 和适配器。

```sh
devenv shell -- pnpm install --frozen-lockfile --store-dir .cache/pnpm-store
devenv shell -- pnpm bench
devenv shell -- pnpm --filter @graftland/benchmarks bench --quick
devenv shell -- pnpm bench --scenario fanout,events --implementation graft,cordis
devenv shell -- pnpm bench --scenario memory-cycles --cycles 1000 --output .cache/long-churn
```

| 选项               | 行为                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--quick`          | 保留原有规模矩阵并减少采样；Remote 内存只测 N=1。仅用于冒烟检查。                                                                                        |
| `--scenario`       | 用逗号分隔下表场景名称的子串。                                                                                                                           |
| `--implementation` | 用逗号分隔实现名称：graft、cordis、avvio、effect、node、emittery；in-process、remote-local、remote-worker、remote-unix、remote-ws、raw-worker、raw-ipc。 |
| `--cycles`         | 覆盖同一根运行时内的加载/卸载循环次数。                                                                                                                  |
| `--output`         | 相对此包的输出路径前缀；默认为 results/latest 或 .cache/quick。                                                                                          |

每个案例完成后保存 JSON 和 Markdown。错误保留在两种输出中，并使命令失败。CI 通过根目录
`pnpm test`
运行等价性测试和小型 runner 冒烟检查，不运行完整性能套件，也不设置速度门槛。

## 场景

| 场景                                              | 每次采样完成的工作                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| cold-load / cold-dispose                          | 激活/卸载 N 个独立插件；N = 1、100、1000。空根运行时的构建不计时。                                |
| fanout-load / fanout-withdraw / fanout-restore    | 一个提供者和 N 个消费者；加载至全部激活，撤回至消费者停止，恢复至全部再次激活。N = 1、100、1000。 |
| chain                                             | D 个插件读取前一个插件的服务；D = 1、10、100，按拓扑顺序注册。                                    |
| service                                           | 从依赖插件内执行 10000 次服务查找和同步方法调用，校验累计值。                                     |
| events-emit / events-sequential / events-parallel | 向 H = 1、10、100 个处理器执行 100 次完整广播。处理器主体同步执行。                               |
| events-bail / events-serial-bail                  | 执行 100 次分发；前面的处理器不返回结果，第 H 个返回 7。                                          |
| events-waterfall                                  | 执行 100 次中间件分发；每层将终端结果 0 加一。                                                    |
| config-update / config-restart                    | 将值从 0 改为 1，分别原地更新或卸载后重新激活。                                                   |
| replace                                           | 在一个事务中替换 K 个不同定义，等待全部新定义激活；K = 1、10、100。                               |
| memory-cycles                                     | 在同一根运行时内对 10 个插件执行 100 次循环，测量堆增长并记录检查点斜率。                         |
| memory-steady                                     | 1000 个存活插件相对空根运行时的堆增量，除以插件数量。                                             |
| import                                            | 在新进程中导入各库，分别记录导入延迟和子进程总耗时。                                              |

## Remote

`@graftland/plugin-remote` 与同一个进程内服务比较，连接包括直接 `local`、直接
`worker`、Unix socket runner 和回环 `ws` runner。原生 worker `postMessage`
与子进程 IPC 提供 echo 基线。runner 服务在计时前就绪。runner 嵌入宿主进程，因此其堆和 CPU 是宿主与 runner 合计的替代测量。这测量同机 runner 的传输成本，不代表跨机器网络、TLS 或认证的成本。

```sh
devenv shell -- pnpm bench --scenario remote-
devenv shell -- pnpm bench --quick --scenario remote-r2,remote-r8
devenv shell -- pnpm bench --scenario remote-r4 --implementation remote-unix,remote-ws
```

| 场景                             | 测量内容                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| remote-r1-start / remote-r1-stop | 从加载条目到依赖插件首次调用成功；从销毁到子进程或 worker 真正退出且消费者稳定。                                                   |
| remote-r2-call                   | 微小载荷的一次调用往返，记录 mean/p50/p99/p999，并比较原生 Node 基线。                                                             |
| remote-r3-throughput             | 以 1、16、256 个在途请求完成 256 次调用；另比较一次契约批次内完成相同 256 个操作。                                                 |
| remote-r4-payload                | 请求和响应分别携带 100 B、10 KB、1 MB、1 MiB、1 MiB+1 B 的 ASCII 文本；拒绝的帧单独标记。                                          |
| remote-r5-stream                 | 完整消费契约支持的流，值为 0..99。                                                                                                 |
| remote-r6-config                 | 进程内更新函数与 Remote 完整重启比较；等待旧执行单元退出和新消费者可用。                                                           |
| remote-r7-footprint              | 1/10/50 个条目的宿主保留堆、子进程 RSS、worker 隔离堆与宿主 RSS 总增量；同一次运行也记录顺序启动 N 个条目的时间。                  |
| remote-r8-loop                   | 相同的五千万步 CPU 循环；宿主事件循环延迟直方图，以及无关进程内服务调用的延迟，包含定时器排队。                                    |
| remote-r9-logs                   | 无日志对照、100 条间隔日志、10000/100000 条突发日志；记录宿主 CPU、接收/丢弃数量和警告频率。计时包含排空和停止，明确标为替代测量。 |
| remote-r10-failure               | 从退出前已确认的通知到 Failed 和消费者停止，也记录原生退出事件到 Failed；进程内宿主退出另行验证。                                  |

Remote 使用固定采样预算：生命周期预热 3 次后采样 20 次；单次调用预热 500 次后采样 5000 次；热批次预热 3 次后采样 30 次；CPU/日志/崩溃各重复 5 次；内存和拒绝边界各重复 3 次。CPU 另丢弃一次相同循环。快速模式降为 2–10 次采样，内存只测 1 个条目，仅用于冒烟检查；原有库场景仍保留全部规模。Remote 使用原生性能时钟和导入/内存测量相同的保守 95% 估计器，保留每次调用的尾延迟和其他观测。热场景复用连接，启动和销毁不计入调用。原生 Node 基线的序列化和调度更简单，相减不能单独分离帧协议成本。5000 次采样的 p999 只有约 5 个最高尾部观测。

默认数据准入数为 16。runner 协议载荷上限是 1
MiB，业务数据还需要信封空间。直接连接使用其他路径，分别测试其边界。Remote 始终通过重启更新配置。Node 的 RSS 计数属于整个进程，无法分离单个 worker
RSS，该项标为 N/A，宿主 RSS 增量是总体估计。日志使用 process.threadCpuUsage 测量宿主线程 CPU，并保留 process.cpuUsage 作为补充。子执行单元保留默认日志格式化，并明确写入 stderr。stdout 防护只统计意外输出，本次 R9 为零字节。直接 worker 的 stderr 由 runner 捕获，local/runner 使用 ProcessObservation 的有界路径。宿主结构化接收器在内存中计数，不包含生产终端或磁盘导出。结构化计数和完整失败 cause 均保留。

每个场景拥有 scope、子进程和 worker，核对原生身份与退出事件；runner 最后用唯一的环境标记扫描遗留进程。Linux
`/proc/self/fd` 缩短 Unix
socket 地址，实际 socket 和状态仍在本工作树内。连接测试把 runner lease 设为 300
ms，避免等待生产默认续租周期；基准保留全部 Remote 默认值。小规模测试核对调用数量和结果、并发载荷、流、配置、日志、CPU 校验值、崩溃传播和实际退出。

[Remote 指南](results/remote-guidance.md)
区分实测事实、推断和对最佳实践指南的修改建议。

## 方法

| 设置                          | 完整运行                                | 快速运行 |
| ----------------------------- | --------------------------------------- | -------- |
| 计时采样                      | 至少 100 次且累计计时工作不少于 2000 ms | 3 次     |
| 预热                          | 至少 20 次且累计计时工作不少于 1000 ms  | 1 次     |
| 每批服务调用/事件分发         | 10000 / 100                             | 100 / 2  |
| 堆测量重复次数/循环次数       | 20 / 100                                | 3 / 5    |
| 新进程导入次数/丢弃的启动采样 | 400 / 3                                 | 3 / 1    |
| GC                            | `--expose-gc`，每个堆检查点请求三次 GC  | 相同     |

Tinybench
6.2.3 提供可等待的迭代钩子和原始计时样本，没有传递依赖。statistics.mjs 合并全部批次，使用保守的 Student-t 误差范围和插值分位数。每个场景、规模和实现独占一个按顺序运行的 Node 工作进程。该进程内的计时采样共享 JIT 状态；每次导入采样都启动新进程。所有计时操作都包含相同的 Effect.runPromise 桥接。准备、计数校验和清理不计时，但卸载场景本身的清理计时。

报告给出均值、p50、p99、ops/s、95% 相对误差范围，以及 Graft 均值与对手均值的比值。热路径批量的 ops/s 按单次服务调用或分发计算。RME 超过 5% 的行保留并标记为噪声较大，不移除离群值。堆增量保留 GC 导致的负值，不计算速度比。不控制 CPU 亲和性、频率、文件系统缓存和其他机器负载。仅凭检查点增长不能断言存在泄漏。

原有库的计时场景在同一工作进程中按 2 秒批次继续采样，直到合并 RME 不超过 4%、累计计时工作达到 24 秒，或工作进程墙钟时间达到 480 秒。保留全部样本。重复检查停止条件后，标称 95% 区间只作描述，不保证序贯置信覆盖率。达到上限的高噪声结果仍明确标注。仅预热一次，后续批次保留 JIT 状态。Remote 的固定采样预算不变。

## 结果

唯一的完整运行包含 295 项测量和 136 个 N/A，无失败。原有库的 154 项计时测量 RME 全部低于 5%。runner 墙钟时间为 4772.3 秒；审计验证 3164 次原生退出，遗留进程为零。仍有 98 项 Remote 测量和三项有符号堆增量 RME 超过 5%。

当 H=100 时，完整运行的 100 次分发批次在 Graft 中耗时 52.85
ms，在 cordis 中耗时 2.63 ms：每次处理函数调用分别为 5.29 µs 和 0.263
µs，相差 20.1 倍。

[完整报告](results/latest.md)
包含每种规模、比较比值、N/A 原因和语义解释。[JSON](results/latest.json)
记录环境、精确版本、代码哈希、样本数、批次历史和原生退出审计。无损原始样本链接到被忽略的
`.cache/samples/`。快速模式默认输出
`.cache/quick.*`，仅用于冒烟检查。results/ 只保留 latest.json、latest.md 和 remote-guidance.md。

从唯一的完整运行结果刷新三种语言的表格：

```sh
devenv shell -- node packages/benchmarks/update-readmes.mjs results/latest.json
devenv shell -- treefmt
```

表格选取各场景的最大规模。数值为每批次均值；memory-steady 使用字节/插件。`*`
表示 RME 超过 5% 或未定义。三种语言保留相同的场景和列标识。

<!-- results:start -->

| Scenario           | Size | Unit     |   Graft | cordis | avvio |  Effect |  Node | emittery |
| ------------------ | ---: | -------- | ------: | -----: | ----: | ------: | ----: | -------: |
| cold-load          | 1000 | ms       | 212.037 | 86.267 | 6.512 |   3.617 |   N/A |      N/A |
| cold-dispose       | 1000 | ms       | 129.024 | 36.605 | 0.175 |   1.230 |   N/A |      N/A |
| fanout-load        | 1000 | ms       | 229.280 | 98.477 | 6.568 |  10.931 |   N/A |      N/A |
| fanout-withdraw    | 1000 | ms       | 154.158 | 43.024 |   N/A |   2.737 |   N/A |      N/A |
| fanout-restore     | 1000 | ms       | 185.885 | 61.085 |   N/A |  11.549 |   N/A |      N/A |
| chain              |  100 | ms       |  45.806 | 25.256 | 0.695 |   1.330 |   N/A |      N/A |
| service            |    1 | ms       |   1.735 | 54.431 | 0.093 |   1.585 |   N/A |      N/A |
| events-emit        |  100 | ms       |  52.854 |  2.632 | 0.067 |   1.306 | 0.067 |    0.777 |
| events-sequential  |  100 | ms       |  54.776 |  3.719 |   N/A |   1.559 |   N/A |    0.770 |
| events-parallel    |  100 | ms       |  78.686 |  5.008 |   N/A |  16.697 |   N/A |    2.143 |
| events-bail        |  100 | ms       |  52.720 |  2.593 |   N/A |   1.472 |   N/A |      N/A |
| events-serial-bail |  100 | ms       |  53.139 |  3.497 |   N/A |   1.387 |   N/A |      N/A |
| events-waterfall   |  100 | ms       |  95.097 | 11.016 |   N/A |  12.778 |   N/A |      N/A |
| config-update      |    1 | ms       |   0.120 |  0.040 |   N/A |   0.002 |   N/A |      N/A |
| config-restart     |    1 | ms       |   0.237 |  0.109 |   N/A |   0.006 |   N/A |      N/A |
| replace            |  100 | ms       |  34.352 |    N/A |   N/A |     N/A |   N/A |      N/A |
| memory-cycles      |   10 | B/batch  |  31828* | 23860* |   N/A |   7649* |   N/A |      N/A |
| memory-steady      | 1000 | B/plugin |   33908 |  10264 |   821 |    2089 |   N/A |      N/A |
| import             |    1 | ms       | 242.159 |  4.409 | 6.126 | 230.756 | 0.173 |    1.988 |

| Scenario             |    Size | Unit    | in-process | remote-local | remote-worker | remote-unix | remote-ws | raw-worker | raw-ipc |
| -------------------- | ------: | ------- | ---------: | -----------: | ------------: | ----------: | --------: | ---------: | ------: |
| remote-r1-start      |       1 | ms      |     2.673* |      866.756 |       698.801 |    1462.665 |  1459.621 |        N/A |     N/A |
| remote-r1-stop       |       1 | ms      |     1.032* |       43.707 |       21.003* |      75.011 |    76.665 |        N/A |     N/A |
| remote-r2-call       |       1 | ms      |     0.007* |        0.626 |         0.568 |       1.195 |     1.346 |     0.028* |   0.051 |
| remote-r5-stream     |     100 | ms      |     0.038* |       3.077* |        3.366* |      6.536* |    5.278* |        N/A |     N/A |
| remote-r6-config     |       1 | ms      |     1.084* |      886.988 |       705.356 |    1509.301 |  1528.991 |        N/A |     N/A |
| remote-r8-loop       |       1 | ms      |     55.592 |      65.366* |        63.998 |      66.895 |    64.864 |        N/A |     N/A |
| remote-r10-failure   |       1 | ms      |        N/A |      33.348* |       14.718* |     65.278* |   58.348* |        N/A |     N/A |
| remote-r3-throughput |     256 | ms      |     2.000* |       61.159 |        57.755 |     168.286 |   184.851 |     1.405* |  1.698* |
| remote-r3-batch      |     256 | ms      |     0.430* |       3.408* |        3.271* |      4.953* |    5.230* |     0.240* |  0.336* |
| remote-r4-payload    | 1048577 | ms      |     0.021* |       9.842* |        8.187* |    rejected |  rejected |     1.306* |  4.960* |
| remote-r7-footprint  |      50 | B/entry |     89574* |      551195* |       506719* |    1260698* |  1263234* |        N/A |     N/A |
| remote-r9-logs       |  100000 | ms      |    63.792* |    1045.619* |      676.101* |   1051.592* |   985.239 |        N/A |     N/A |

<!-- results:end -->

## 语义边界

| 库              | 比较边界                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Graft           | 等待 Active，而非仅完成注册。配置场景解码 Schema.Int；事件调用恢复上下文，并拥有各自的作用域。                                                |
| cordis          | 固定为 4.0.0-rc.12；等待 inertia 并检查状态。serial 可以提前返回；emit/bail 同步执行。此版本没有 registry.replace。                           |
| avvio           | 按顺序启动并执行关闭钩子。运行时卸载、重启和替换为 N/A。整个加载器关闭和手动服务连接明确标为替代测量。events-emit 使用其继承的 EventEmitter。 |
| Effect          | 显式连接 Layer/Scope，手动停止和重建消费者；并行广播使用 PubSub，其他模式使用手写循环。不声称具有自动响应依赖变化的图。                       |
| Node / emittery | 仅比较分发。Node emit 执行完同步主体后返回；emittery 延后并等待监听器。两者都不提供 bail 或中间件。                                           |

配置比较启用 Graft 验证，不为 cordis 安装可选 schema。waterfall 仅比较输出包装：两者传递 next 输入和重复调用 next 的行为不同。所有处理器主体同步执行，因此事件表不衡量异步 I/O 吞吐量。各场景报告标明替代测量，并给出可验证的其他解释。

## 来源与检查

根目录测试命令和工作进程池保持不变。Remote 连接见证在同一协调进程中依次运行，使用独立根作用域并验证原生退出。目前 runner 进程归属审计和短 Unix 路径适配面向 Linux。

根目录的 `devenv.nix`
将庞大的生成结果 JSON 排除在格式化之外。源文件和 Markdown 仍执行格式化。

[SOURCES.md](SOURCES.md) 列出源文件路径、行号、常量、完成条件和 N/A 证据。
[等价性测试](test/equivalence.test.ts)
在清理前后检查激活、终结器、处理器、服务调用的次数，以及配置更新和返回结果，并检查重复卸载循环。
[运行器测试](test/runner.test.ts)
检查新进程导入和模块入口不主动执行工作。实现检查与性能解读分开记录。

```sh
devenv shell -- pnpm typecheck
devenv shell -- pnpm test
devenv shell -- pnpm build
devenv shell -- treefmt
```

根目录改动注册 bench 命令和类型检查项目，并将生成的结果 JSON 排除在格式化之外。现有包发现、测试矩阵和发布发现逻辑已支持此私有包。未修改 core、loader 或其他现有包的源代码。

只对计时操作进行剖析，排除根环境准备、观察断言和释放。原始 CPU 剖析文件保留在被忽略的缓存中。采样会扰动计时；剖析用于解释执行路径，不能替代基准估计。

```sh
devenv shell -- node packages/benchmarks/profile.mjs --scenario events-emit --implementation graft --size 100 --calls 100
devenv shell -- node packages/benchmarks/profile.mjs --scenario cold-load --implementation cordis --size 1000 --calls 1
```

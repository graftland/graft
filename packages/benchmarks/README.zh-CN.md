# Graft 性能基准

这是一个私有工作区包，用于比较 Graft、cordis、avvio、原生 Effect、Node
EventEmitter 和 emittery。先检查各实现完成的工作是否一致，再解读速度差异。报告把不支持的操作列为 N/A，并说明原因。

## 运行

所有命令都从仓库根目录运行。依赖和 pnpm 存储保留在当前工作树中。基准命令先构建 Graft 和适配器。

CI 在推送到 `main` 和修改 `packages/`
的拉取请求上运行快速套件，每周或通过 Benchmarks 工作流的 **Run workflow**
按钮运行完整套件。每次运行把报告写入作业摘要，JSON 放进构件。CI 运行器是共享的，所以 CI 只报告数字，不因数字失败；只在 CI 运行之间比较。

```sh
devenv shell -- pnpm install --frozen-lockfile --store-dir .cache/pnpm-store
devenv shell -- pnpm bench
devenv shell -- pnpm --filter @graftland/benchmarks bench --quick
devenv shell -- pnpm bench --scenario fanout,events --implementation graft,cordis
devenv shell -- pnpm bench --scenario memory-cycles --cycles 1000 --output .cache/long-churn
```

| 选项         | 行为                                                              |
| ------------ | ----------------------------------------------------------------- |
| `--quick`    | 保留原有规模矩阵并减少采样；Remote 内存只测 N=1。仅用于冒烟检查。 |
| `--scenario` | 用逗号分隔下表场景名称的子串。                                    |
| `--cycles`   | 覆盖同一根运行时内的加载/卸载循环次数。                           |
| `--output`   | 相对此包的输出路径前缀；默认为 results/latest 或 .cache/quick。   |

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
| memory-cycles                                     | 在同一根运行时内对 10 个插件执行 100 次循环，测量堆增长并记录检查点斜率。                         |
| memory-steady                                     | 1000 个存活插件相对空根运行时的堆增量，除以插件数量。                                             |
| import                                            | 在新进程中导入各库，分别记录导入延迟和子进程总耗时。                                              |

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
| memory-cycles      |   10 | B/batch  |  31828* | 23860* |   N/A |   7649* |   N/A |      N/A |
| memory-steady      | 1000 | B/plugin |   33908 |  10264 |   821 |    2089 |   N/A |      N/A |
| import             |    1 | ms       | 242.159 |  4.409 | 6.126 | 230.756 | 0.173 |    1.988 |

<!-- results:end -->

## 语义边界

| 库              | 比较边界                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Graft           | 等待 Active，而非仅完成注册。配置场景解码 Schema.Int；事件调用恢复上下文，并拥有各自的作用域。                                          |
| cordis          | 固定为 4.0.0-rc.12；等待 inertia 并检查状态。serial 可以提前返回；emit/bail 同步执行。                                                  |
| avvio           | 按顺序启动并执行关闭钩子。运行时卸载和重启为 N/A。整个加载器关闭和手动服务连接明确标为替代测量。events-emit 使用其继承的 EventEmitter。 |
| Effect          | 显式连接 Layer/Scope，手动停止和重建消费者；并行广播使用 PubSub，其他模式使用手写循环。不声称具有自动响应依赖变化的图。                 |
| Node / emittery | 仅比较分发。Node emit 执行完同步主体后返回；emittery 延后并等待监听器。两者都不提供 bail 或中间件。                                     |

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

---
title: 应用发布
description: 在一个应用中构建、检查、应用和回滚不可变的托管部署。
---

**应用发布**是由 `@graftland/plugin-release` 管理的内容寻址目录。其 `Releases`
服务通过[执行切换](../transitions/)更新具名的托管 Worker 和子进程集成。

- 所有变更条目都返回 `Accepted` 后，当前发布 id 才会前进。
- 规划时解码配置，应用时执行探针和试运行。
- 启动时选择日志中最后一次完整接受的发布。

## 版本化内容

| 内容       | 发布中记录的内容                                                                             |
| ---------- | -------------------------------------------------------------------------------------------- |
| 实现包     | 完整的捕获目录，通过 [Artifact](../remote/artifacts/) 验证。                                 |
| 配置       | 规范化的 `graft.yml`：条目 id、编码后的输入、契约模块、直接部署位置和探针名称。              |
| 发布元数据 | `manifests.json` 中生成的清单和基于包的来源记录。来源记录不等于兼容性。                      |
| 发布清单   | `release.json`：条目、能力和凭证引用、撤销列表。                                             |
| 不包含     | 业务数据、解析后的秘密值、宿主插件、宿主切换策略和外部运行时依赖。外部依赖不会被捕获或固定。 |

将存储目录放在应用的依赖解析树中。包文件和配置字面量中不得包含秘密值：构建器无法识别任意秘密字面量。使用
`!env NAME` 或
`{ "$env": "NAME" }`；发布只保存名称，在内存中解析值。环境引用会自动以
`env:NAME`
加入引用清单。其他能力和凭证引用必须显式列出。回滚会重新解析引用，不会还原旧秘密值。

## 构建发布

发布源使用 Loader 条目 id，但只接受托管 Remote 条目。包目录相对于源文件。
`entry`
选择包的公开导出；包需要[发布清单](../ecosystem/manifest/)中由作者维护的字段。

契约路径和包标识符在构建时相对于发布源文件解析。与发布检查一致，包导出需要支持 Node 默认解析。发布记录一个规范化的文件 URL，规划和执行使用同一个 URL；拒绝其他 URL 协议以及文件 URL 的查询参数和片段。契约包身份和目录摘要来源记录保持不变。

```yaml title="forecast-release.yml"
- id: forecasts
  name: "@graftland/plugin-remote"
  config:
    package: ./packages/forecasts
    entry: .
    contract: "@example/forecast-contract"
    target: { _tag: Worker }
    config:
      release: unused
      started: unused
      prefix: updated
      credential: !env FORECAST_TOKEN
    probes: [health]
```

先用导出的 `build` effect 创建首个发布，再在宿主中安装
`plugin({ store, initial, host, socket })`。`host`
提供实际的 Node、Effect、Graft 版本、服务来源记录和部署能力。默认 Loader 入口接受相同设置，但不含
`policy`；嵌入式宿主可向 `plugin`
传入切换策略。试运行默认两秒，其余预算采用核心默认值。插件拥有这些集成，不要再通过 Loader 重复加载它们。

## 规划和应用

将 `@graftland/plugin-release/cli`
启用为命令插件。所有命令都连接正在运行的应用的 Unix
socket；构建路径也在那里解析。

```sh
graft release build /app/forecast-release.yml --socket /app/control.sock --json
graft release plan TARGET --socket /app/control.sock --json
graft release apply TARGET --expected CURRENT --socket /app/control.sock --json
graft release rollback --expected CURRENT --socket /app/control.sock --json
graft release history --socket /app/control.sock --json
graft release status --socket /app/control.sock --json
```

| 操作     | 规则                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `plan`   | 验证字节，检查服务绑定、来源和运行时要求，解码配置。列出代码、配置、新增和移除变更。                                          |
| `apply`  | 在发布锁内检查预期的当前 id。仅配置变更也会以新输入切换同一产物。                                                             |
| 失败     | `Aborted` 或 `Recovered` 保留之前的 id。更早接受的条目按逆序通过新的切换补偿。                                                |
| 补偿失败 | 将部署标记为 `Degraded`，重启前拒绝后续应用。`RecoveryFailed` 和 `Stuck` 不会被报告为成功回滚。                               |
| 边界     | 拒绝在线新增、移除、契约或部署位置变更，以及非托管编辑。新的条目集合需要单独初始化存储并重启应用。                            |
| 并发     | 一个进程拥有一个存储。已接纳的应用操作属于插件作用域，不属于请求连接。对这些条目只使用 Releases；观察到外部切换会使规划无效。 |

多条目变更按顺序进行，不保证整组原子可见。最后接受的 id 与 `Applying` 或
`Degraded`
状态同时显示。退出码零表示命令成功；拒绝、不成功的切换结果和传输失败返回非零。`--json`
输出结构化回复。

规划导入的资源在返回前释放。活跃契约的导入资源由发布插件持有，随插件关闭。

控制客户端的十分钟期限覆盖连接、响应头和响应体。超时或中断会关闭 socket，即使服务器已连接却始终不发送响应头。

## 日志和撤销

恢复时只验证历史发布的字节和已保存的元数据，不导入旧实现。只有选中的发布接受运行时和来源检查，因此已淘汰的外部依赖不会阻止重启。

启动单元前，恢复流程根据已接受的初始化记录和已完成事务验证当前、之前的 id 和累计撤销。每个变更条目都必须有接受结果才能提交。即使符合 schema，日志内容不一致也会被拒绝；启动不会将未完成的意图提升为已接受发布。

同步并原子替换的日志记录意图、安全的切换结果摘要、当前和之前的 id，以及启动选择。中断的意图不会继续执行：启动从最后接受的发布创建单元。损坏时拒绝启动。一起保护日志和发布存储。原始 cause 和解码后的输入不会写入磁盘或控制回复；进程内调用者保留完整 cause。损坏的日志不会自动修复。

构建会继承已提交的 `revocations`。`--revoke credential:old` 添加撤销；
`--reference credential:old`
声明使用中的引用。应用发布（包括回滚）时，如果其引用与累计撤销相交就会失败。`--override-revocations`
显式授权恢复，并记录在日志中；它不会删除撤销记录。撤销控制发布选择，不控制外部凭证签发方。

socket 目录仅允许应用所有者访问；socket 权限为
`0600`。宿主网关放在发布插件子树之外。Graft 负责一个应用内的切换；跨实例发布使用现有部署工具。外部步骤和不可逆点不属于这一发布层。

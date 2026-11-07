# Phase 1：Remote 迁移交接

本记录对应阶段 1 第 5 步的 plugin-remote 工作。没有提交、推送或对外发布；由主工程师将本部分与 core、plugin-release 一起提交。

## 最终检查

| 检查                                                                 | 最后结果                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `devenv shell -- pnpm typecheck`                                     | 通过，保留全部 Effect language-service 诊断。                              |
| `devenv shell -- pnpm vitest run --project @graftland/plugin-remote` | 串行运行通过：50 个文件，401 项通过、1 项跳过，共 402 项；耗时 176.35 秒。 |
| `devenv shell -- git diff --check`                                   | 通过。                                                                     |
| core、remote 包构建                                                  | 在接口变化后刷新过产物并通过；全量 build 与 TypeDoc 由最后一步检查。       |

跳过项是既有的 Linux
bubblewrap 隔离测试，在当前非 Linux 平台不执行。本次没有新增跳过项。完整 Remote 测试结束后不再修改生产代码。

## 最终行为

| 部分         | 行为与依据                                                                                                                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 静态声明     | `Artifact.metadata` 先验证捕获内容，再读取已纳入摘要的 `package.json` 中的 `graft.overlap`，全程不导入实现。没有声明或声明为 false 时默认 Restart；显式 Overlap 在候选执行前被拒绝。运行后的描述仍必须与重叠声明及原有服务操作兼容。 |
| 准备与所有权 | Remote 的 `Driver.prepare` 验证元数据并建立 Policy 绑定，不执行候选或准备 sandbox。准备 Scope 由 core 的原始清理所有者管理；Stuck 时由迟到结算继续持有。                                                                             |
| 期望与解析   | `ManagedOptions` 删除 `policy`，拆分为 `budget` 与 `requirements`，并转发 `resolve`、`queue`。受管理插件先保留 `Schema.Json` 期望输入，分配前由 resolver 解析，实际配置在单元的合约边界解码。初始启动和恢复都重新解析。              |
| 分配与任期   | 分配接收 core 授予的 Change、generation、routeVersion 与 term；Unit 原样返回 acknowledgement。没有把这些值暴露给单元内插件，也没有声称跨运行时重启 fencing。                                                                         |
| 固定资源选择 | Remote 的纯 `footprint` 包括 artifact identity、contractModule 与完整 target（含 execArgv 或 command）。解析后改变该选择会在驱动分配和插件执行前失败，要求新的 Change。内容相同的制品目录位置不是资源选择；每次仍重新验证目录。      |
| 授权         | `Trust.Comparison.revision` 来自每个逻辑 entry 的单调版本墓碑。投影变化、批准、撤销和服务声明变化会推进相关 entry 的版本；相同声明的重复绑定不会自我失效。初始单元也必须在执行前获批。                                               |
| 文档         | 英文、简体、繁体的 `remote/artifacts.md` 同步描述静态重叠声明。`CandidateOptions` schema 值与 `Artifact.Metadata` 从公开入口导出。                                                                                                   |

静态元数据只证明部署声明来自被验证的捕获内容。它不是对任意插件代码的行为证明，也不证明 RPC 请求 Scope 已完成。RPC 返回、调用者取消、stop/terminate
acknowledgement 仍不能替代执行退出证据；包括普通一元 RPC 的通用请求 Scope 排空继续推迟到阶段 2。已存在的“响应后请求 finalizer 仍阻塞”测试只观察单元最终退出，不认证通用远端 drain。

## 十项新增测试

| 文件                            | 测试名                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `test/artifact.test.ts`         | `verifies overlap metadata without importing the implementation`                          |
| `test/artifact.test.ts`         | `defaults an absent overlap declaration to Restart`                                       |
| `test/policy-revisions.test.ts` | `retains per-entry authorization revisions through projection ABA and duplicate bindings` |
| `test/policy-revisions.test.ts` | `admission and binding do not inspect unrelated policy entries`                           |
| `test/transition.test.ts`       | `Worker rejects explicit Overlap without verified metadata before candidate execution`    |
| `test/transition.test.ts`       | `Local rejects explicit Overlap without verified metadata before candidate execution`     |
| `test/transition.test.ts`       | `Worker resolves rotated credentials from the previous desired input during recovery`     |
| `test/transition.test.ts`       | `Local resolves rotated credentials from the previous desired input during recovery`      |
| `test/transition.test.ts`       | `rejects a resolver that changes the verified placement footprint before allocation`      |
| `test/trust.test.ts`            | `rejects an unapproved initial artifact before sandbox preparation or execution`          |

既有
`terminating an allocated unit confirms NotStarted and prevents later startup`
另增加 acknowledgement 令牌断言。既有 lost-transport 测试保留“不以终止命令确认当作 exit”的断言，并在新请求中显式设置 TestClock 驱动的预算。

## 失败批次及修正

| 批次                 | 观察、原因与处理                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 元数据先失败测试     | 新增两个 `Artifact.metadata` 测试时 API 尚不存在，两项失败；实现后 artifact 文件 9 项全过。                                                                                                                                                                                      |
| footprint 先失败测试 | 解析器将 Worker 改为 Local 时，缺少 footprint 钩子的实现真实返回 Accepted，新增测试要求 Aborted 因而失败。加入纯 footprint 与 core 分配前比较后通过。                                                                                                                            |
| 早期四文件批次       | 27 项失败、41 项通过、1 项跳过。部分测试进程在 core 尚未接入 prepare 时启动，仍选择 Restart；此外既有 trial 预算与初始授权语义需要显式迁移。没有把这些失败改成宽松结果集合。                                                                                                     |
| 第一次全 Remote 批次 | 49 个文件中 2 个失败；10 项失败、388 项通过、1 项跳过。旧 trial=5 秒、total=30 秒的请求小于新的 32.6 秒最小预算，准入早拒绝后测试仍等待 Serving；fixture 总预算改为 60 秒，保留原本 5 秒试运行。                                                                                 |
| 同一批次的旧断言     | 制品篡改如今在 prepare 阶段拒绝，测试改为没有 Change id 的 ChangeRejected/Unsupported，而非 Aborted。恢复失败后的门面现在给出声明的 AdmissionRejected，而非旧 Unavailable。未获批初始单元现在在执行前拒绝；成功启动的授权测试显式先批准。                                        |
| lost-transport 测试  | 包装驱动漏转发 prepare，且请求没有携带旧 Registration 的 100ms 预算，导致 TestClock 等待超时。转发真实 prepare、为 fixture 添加静态声明，并在 Change.Request 显式设置预算后，4 项 driver 测试通过。                                                                              |
| 准备 Scope 清理      | Worker/Local 凭证恢复断言已成功，但外层清理出现 ReleaseInterrupted。定位到 core 准备资源的原始清理所有者未及时释放；主工程师修正所有权后，保留原背景 crash 场景通过，没有吞掉 cause 或绕过上游缺口。                                                                             |
| 中间两文件复核       | 6 项失败、34 项通过、1 项跳过。除两个旧门面拒绝断言外，发现真实 trial=0 缺陷：最短试运行被错误包在 1ms 操作 deadline 内；详细证据显示 Cutover 后 Trial TimedOut，继而真实恢复。core 取消虚构的 1ms deadline；正数 trial 由总剩余预算约束，零 trial 不等待。                      |
| 针对性复核           | trial 修正后，transition、policy、policy-revisions 共 3 文件 65 项全过；包括全部 Local 旧调用场景、Worker 输入快照恢复、footprint 拒绝及局部对象访问检查。                                                                                                                       |
| 类型与诊断           | 开发期间出现过陈旧包声明缺少 prepare/revision/footprint、测试 JSON.stringify、原生 String.repeat、嵌套泛型推断为 unknown、重复 mapError 等错误。分别刷新构建、使用固定 JSON/Effect String、先选择声明再读服务键、合并错误映射；最终 typecheck 全过，无断言或诊断关闭来强行通过。 |
| 测试环境             | 早期曾同时启动多个 Remote Vitest，globalSetup 会共享重建 dist 与 fixture cache。这些运行没有被当作最终证明；最后全包验证只运行一个 Remote Vitest，完整通过。临时测试目录由各自 Scope 清理，没有软链 node_modules。                                                               |

## Policy 访问范围

| 路径                            | 当前访问范围                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change 准入、授权比较           | bindings、assignments、declarations、approvals 先按 entry 查 HashMap；只在该 entry 内选候选或匹配声明。投影按该声明的 service keys 查索引，撤销引用查 HashSet。                 |
| 分配、绑定、释放、onRevoke 注册 | 更新该 entry 的不可变数组、服务所有者 retain 计数和 HashMap 路径；不遍历无关 entry。保留原来的单 TxRef 原子状态。                                                               |
| 实测                            | 为 100 个无关 entry 的真实生产 State 索引数组安装 Proxy，执行 production bind 与 comparison，记录的无关对象访问为 0。这个测量不宣称负载下延迟恒定，也不计 operator 控制面扫描。 |
| 安装                            | 一次性验证所有 policy entries 并建立索引，成本随整个初始策略增长。                                                                                                              |
| operator publish                | 仍扫描当前投影和保留的声明以选择受影响 entry，并重建 projectionsByService。属于控制面全量工作，不能据局部 Change 测试宣称它局部。                                               |
| operator revoke                 | 仍扫描 policy.entries，选择与引用相交的 entry；后续回收与批准删除按受影响 entry 索引。                                                                                          |
| 全量观察、关闭                  | statements 明确列出整个策略；Policy Scope 关闭明确收集全部回收者。这两条路径本来就涉及全体。                                                                                    |

最值得审查的是 Policy 索引与计数更新的一致性，以及 core/Remote 准备绑定、实际分配绑定、迟到结算三者的 Scope 归属。静态声明是新的部署格式选择，需审查其与操作者控制的内容寻址存储前提是否一致。没有已确认的真实阻塞；通用 RPC
completion 与可靠中断归因仍按上游草稿保留能力限制。
